const CountryWallet = require('../models/CountryWalletModel');
const { toCode, DEFAULT_COUNTRY } = require('../utils/country');

/**
 * The live market list, cached.
 *
 * Every page render needs to know which countries have wallets — the header
 * shows the active balance in its own currency, the country picker marks which
 * markets are buyable, and the product filter depends on it. That is a query on
 * a collection that changes only when an admin adds or hides a market, so it is
 * held in memory for a short while rather than re-read on every request.
 *
 * The TTL is deliberately short: a stale entry means an admin waits up to a
 * minute to see a market they just created, which is a much better failure than
 * a query on every request.
 */

const TTL_MS = 60 * 1000;

let cache = null;
let cachedAt = 0;

/** Drop the cache. Called after any admin write so their own change shows up now. */
function invalidate() {
  cache = null;
  cachedAt = 0;
}

/** Every active market, as plain objects. */
async function markets() {
  const now = Date.now();
  if (cache && now - cachedAt < TTL_MS) return cache;

  cache = await CountryWallet.find({ isActive: true }).sort({ country: 1 }).lean();
  cachedAt = now;
  return cache;
}

/** One market, or null when that country has no live wallet. */
async function market(country) {
  const code = toCode(country);
  if (!code) return null;
  const all = await markets();
  return all.find(m => m.country === code) || null;
}

/** ISO codes of every live market. */
async function codes() {
  return (await markets()).map(m => m.country);
}

/** Does this country have a live wallet — i.e. can money be held in it? */
async function hasWallet(country) {
  return !!(await market(country));
}

/**
 * Currency for a market, falling back to Nigeria.
 *
 * The fallback matters: a balance must never be rendered without a symbol, and
 * a user whose active market was hidden by an admin still has money sitting in
 * Naira. Returning the Naira symbol there is correct, not a guess.
 */
async function currency(country) {
  const m = (await market(country)) || (await market(DEFAULT_COUNTRY));
  if (!m) return { symbol: '', code: '', name: '' };
  return { symbol: m.currencySymbol, code: m.currencyCode, name: m.currencyName };
}

module.exports = { markets, market, codes, hasWallet, currency, invalidate };
