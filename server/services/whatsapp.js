/**
 * WhatsApp verification codes, via Meta's WhatsApp Cloud API.
 *
 * Everything here runs server-side, deliberately. The original prototype
 * (whatsapp/whatsapp/*.html) called Meta directly from the browser with the
 * access token embedded in the page, and generated + compared the code in
 * sessionStorage. That gave away a token with messaging rights on the
 * business number to anyone who opened the page, and made the code itself
 * worthless as a check — you could read the expected value in devtools. Since
 * this code now gates a cash bonus, both halves have to be server-held:
 * the token lives in the environment, and the code is hashed onto the user
 * document and compared here.
 *
 * Required environment:
 *   WHATSAPP_TOKEN            Meta access token (rotate if it ever leaks)
 *   WHATSAPP_PHONE_NUMBER_ID  the sending number's id
 *   WHATSAPP_TEMPLATE         optional, defaults to the account's existing
 *                             'bittoken_verify' template
 */
const axios = require('axios');
const { parsePhoneNumberFromString, getCountries, getCountryCallingCode } = require('libphonenumber-js/max');
const isoCountries = require('i18n-iso-countries');

isoCountries.registerLocale(require('i18n-iso-countries/langs/en.json'));
const crypto = require('crypto');
const logger = require('../config/logger');

const GRAPH_VERSION = 'v25.0';
const TEMPLATE = process.env.WHATSAPP_TEMPLATE || 'bittoken_verify';
const TEMPLATE_LANG = process.env.WHATSAPP_TEMPLATE_LANG || 'en_US';

const CODE_TTL_MS = 15 * 60 * 1000;   // matches the email OTP's 15 minutes
const MAX_SENDS_PER_WINDOW = 5;        // per user, per window
const SEND_WINDOW_MS = 60 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;  // one message a minute at most
const MAX_TRIES = 6;                   // wrong-code attempts before a resend is required

function isConfigured() {
  return Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
}

/**
 * Normalises whatever the user typed into the forms the app needs.
 *
 * This started as a hand-written Nigerian parser, which quietly locked out
 * every other market: Ghana is live with real users, and there are also
 * accounts across Ethiopia, Benin, South Africa, Togo and Zambia. None of
 * them could have verified, so none of them could ever have claimed the
 * bonus. WhatsApp itself has no such limit — the Cloud API takes any E.164
 * number — so the restriction was entirely self-inflicted.
 *
 * Hand-rolling numbering rules for 245 countries is not maintainable, so
 * this defers to libphonenumber (the /max build, which carries the number-
 * type metadata the default build omits — without it a landline or a
 * 15-digit typo both pass as valid).
 *
 * `defaultCountry` is an ISO code used to read numbers typed in local form
 * ("0803..."), which is how people actually type their own number. An
 * explicit +country prefix always wins over it.
 *
 * Returns null when the number cannot be a real mobile line.
 */
function normalizePhone(raw, defaultCountry) {
  const input = String(raw || "").trim();
  if (!input) return null;

  const parsed = parsePhoneNumberFromString(
    input,
    defaultCountry ? String(defaultCountry).toUpperCase() : undefined,
  );
  if (!parsed || !parsed.isValid()) return null;

  /* Permissive about type on purpose. Plenty of numbering plans cannot tell
     mobile from fixed line (FIXED_LINE_OR_MOBILE), and WhatsApp is the real
     arbiter anyway — it either delivers or returns an error we surface. So
     only the types a person could not receive a WhatsApp message on are
     turned away. */
  const type = parsed.getType();
  if (['TOLL_FREE', 'PREMIUM_RATE', 'SHARED_COST', 'FIXED_LINE'].includes(type)) return null;

  const country = parsed.country || null;

  /* The local form only means something where we sell data, and every data
     product is Nigerian (both providers are). So it is derived for Nigeria
     and left null elsewhere, which is what stops a Ghanaian number being
     saved as a beneficiary nobody could buy a bundle for. */
  const local = country === 'NG' ? '0' + parsed.nationalNumber : null;

  return {
    e164: parsed.number.replace(/^\+/, ""),   // Cloud API wants digits, no plus
    e164Pretty: parsed.formatInternational(),
    national: String(parsed.nationalNumber),
    local,
    country,
    type: type || null,
  };
}

/**
 * Dial-code list for the number field, so a user can pick their own country
 * instead of being assumed Nigerian. Built once at load — it never changes.
 */
function countryDialList() {
  return getCountries()
    .map((code) => ({
      code,
      name: isoCountries.getName(code, 'en') || code,
      dial: '+' + getCountryCallingCode(code),
    }))
    .filter((c) => c.name)
    .sort((a, b) => a.name.localeCompare(b.name));
}

const hashCode = (code) => crypto.createHash('sha256').update(String(code)).digest('hex');

// Six digits, to match the email OTP. The prototype used five; two different
// code lengths in one product is a needless inconsistency for the user.
const generateCode = () => String(crypto.randomInt(100000, 1000000));

/**
 * Sends the verification template. Resolves on success, throws with a
 * user-safe message otherwise.
 */
async function sendCode(e164, code) {
  if (!isConfigured()) {
    throw new Error('WhatsApp verification is not configured on this server.');
  }

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const body = {
    messaging_product: 'whatsapp',
    to: e164,
    type: 'template',
    template: {
      name: TEMPLATE,
      language: { code: TEMPLATE_LANG },
      components: [
        { type: 'body', parameters: [{ type: 'text', text: code }] },
        // The template carries a URL button that also takes the code; Meta
        // rejects the whole message if a declared button parameter is missing.
        { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
      ],
    },
  };

  try {
    const res = await axios.post(url, body, {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      timeout: 20000,
    });
    logger.info(`[WHATSAPP] Code sent to ${e164.slice(0, 6)}****${e164.slice(-2)} (msg ${res.data?.messages?.[0]?.id || 'n/a'})`);
    return true;
  } catch (err) {
    const meta = err.response?.data?.error;
    // Never surface Meta's raw text to the user — it leaks template names and
    // account ids — but keep all of it in the log.
    logger.error(`[WHATSAPP] Send failed for ${e164}: ${meta ? JSON.stringify(meta) : err.message}`);

    if (meta?.code === 131030) {
      throw new Error('That number is not allowed to receive messages from us yet. Please contact support.');
    }
    if (meta?.code === 132000 || meta?.code === 132001) {
      throw new Error('Verification is temporarily unavailable. Please try again shortly.');
    }
    throw new Error('We could not send the code. Check the number and try again.');
  }
}

/**
 * Decides whether this user may be sent another code right now, based on the
 * counters stored on their document.
 */
function checkSendAllowance(user) {
  const now = Date.now();
  const last = user.whatsappLastSentAt ? new Date(user.whatsappLastSentAt).getTime() : 0;

  if (last && now - last < RESEND_COOLDOWN_MS) {
    const wait = Math.ceil((RESEND_COOLDOWN_MS - (now - last)) / 1000);
    return { ok: false, message: `Please wait ${wait}s before asking for another code.` };
  }

  // The window rolls: once the oldest send falls outside it, the count resets.
  const windowOpen = last && now - last < SEND_WINDOW_MS;
  const count = windowOpen ? (user.whatsappSendCount || 0) : 0;
  if (count >= MAX_SENDS_PER_WINDOW) {
    return { ok: false, message: 'Too many codes requested. Please try again in an hour.' };
  }

  return { ok: true, nextCount: count + 1 };
}

module.exports = {
  isConfigured,
  normalizePhone,
  countryDialList,
  hashCode,
  generateCode,
  sendCode,
  checkSendAllowance,
  CODE_TTL_MS,
  MAX_TRIES,
};
