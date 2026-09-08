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
 * Normalises whatever the user typed into the two forms the app needs.
 *
 * The codebase is inconsistent about phone format — beneficiaries and the
 * data-purchase inputs use the local 11-digit "0801..." form, while the
 * checkout edit modal writes "+234801...". WhatsApp needs international
 * digits with no plus. Rather than inherit that mess, both forms are derived
 * once here and stored, so nothing downstream has to guess.
 *
 * Returns null when the input cannot be read as a Nigerian mobile number.
 */
function normalizeNigerian(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return null;

  let national;                     // 10 digits, no leading zero
  if (digits.startsWith('234') && digits.length === 13) national = digits.slice(3);
  else if (digits.startsWith('0') && digits.length === 11) national = digits.slice(1);
  else if (digits.length === 10) national = digits;
  else return null;

  // Nigerian mobile prefixes all start 70/80/81/90/91 after the leading zero.
  if (!/^[789][01]\d{8}$/.test(national)) return null;

  return { e164: '234' + national, local: '0' + national, national };
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
  normalizeNigerian,
  hashCode,
  generateCode,
  sendCode,
  checkSendAllowance,
  CODE_TTL_MS,
  MAX_TRIES,
};
