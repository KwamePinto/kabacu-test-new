const countries = require('i18n-iso-countries');
countries.registerLocale(require('i18n-iso-countries/langs/en.json'));

/**
 * Country values arrive in three different shapes across this codebase:
 *
 *   user.country      lowercase display name  ("nigeria", "south africa")
 *   header picker     ISO alpha-2 code        ("NG")  — localStorage kbc_country
 *   product.country   ISO alpha-2 code        ("NG")  — the canonical form
 *
 * Everything is normalised to the ISO code before comparison so a user whose
 * profile says "nigeria" matches a package tagged "NG".
 */

const DEFAULT_COUNTRY = 'NG';

/** Anything → ISO alpha-2 uppercase, or null when unrecognised. */
function toCode(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  // Already a code
  if (/^[A-Za-z]{2}$/.test(raw)) {
    const up = raw.toUpperCase();
    return countries.isValid(up) ? up : null;
  }

  return countries.getAlpha2Code(raw, 'en')
      || countries.getAlpha2Code(raw.replace(/\b\w/g, c => c.toUpperCase()), 'en')
      || null;
}

/** ISO code → display name, falling back to the code itself. */
function toName(code) {
  if (!code) return '';
  return countries.getName(String(code).toUpperCase(), 'en') || String(code).toUpperCase();
}

/** Flag emoji for an ISO code. */
function toFlag(code) {
  const c = String(code || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return '';
  return c.replace(/./g, ch => String.fromCodePoint(127397 + ch.charCodeAt(0)));
}

/** Every country as { code, name }, alphabetical — for admin dropdowns. */
function allCountries() {
  const names = countries.getNames('en', { select: 'official' });
  return Object.keys(names)
    .map(code => ({ code, name: names[code] }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Which market this request should see.
 *
 *   signed in  → the country on their profile. They are locked to their own
 *                market, so a Ghanaian account never sees Nigerian bundles.
 *   signed out → whatever they picked in the header (cookie), or null meaning
 *                "no filter, show everything".
 *
 * Returns { code, locked }. `locked` is true for signed-in users, which is what
 * tells the views to render "coming soon" instead of an empty grid.
 *
 * req.user is only the slim JWT payload, so the profile country needs a lookup.
 * It is memoised on the request because several controllers ask for it.
 */
async function resolveViewerCountry(req) {
  if (req._viewerCountry) return req._viewerCountry;

  let result;

  if (req.user) {
    // Required lazily: this module is loaded by the model layer too, and a
    // top-level require here would create a cycle.
    const User = require('../models/UserModel');
    const doc = await User.findById(req.user.id).select('country').lean();
    result = { code: toCode(doc && doc.country), locked: true };
  } else {
    const picked = toCode(req.cookies && req.cookies.kbc_country);
    result = { code: picked, locked: false };
  }

  req._viewerCountry = result;
  return result;
}

/**
 * Mongo filter fragment for a resolved viewer country.
 * Signed-out visitors with no pick get {} — every market.
 */
function countryFilter(viewer) {
  if (!viewer || !viewer.code) return {};
  return { country: viewer.code };
}

module.exports = {
  DEFAULT_COUNTRY,
  toCode,
  toName,
  toFlag,
  allCountries,
  resolveViewerCountry,
  countryFilter,
};
