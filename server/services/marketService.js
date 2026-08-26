const CountryWallet = require('../models/CountryWalletModel');
const { toCode, DEFAULT_COUNTRY, currencyFor } = require('../utils/country');

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

/**
 * Every active market, as plain objects.
 *
 * When the collection is empty — a database that predates country wallets, or
 * one an admin has not seeded yet — an implicit Nigeria market stands in. Before
 * markets existed, Nigeria was the only one there was, so reporting it as live is
 * describing the truth rather than inventing a default: those users hold Naira in
 * `balances.NAIRA` whether or not a CountryWallet row exists to say so.
 *
 * Without this, every market-dependent path fails closed at once: the wallet
 * switcher empties, balances render with no currency symbol, and the guard on
 * the purchase path refuses every order. That is a hard outage caused purely by
 * a missing row, which is not a reasonable thing to make the site depend on.
 */
async function markets() {
  const now = Date.now();
  if (cache && now - cachedAt < TTL_MS) return cache;

  const rows = await CountryWallet.find({ isActive: true }).sort({ country: 1 }).lean();
  cache = rows.length ? rows : [implicitDefault()];
  cachedAt = now;
  return cache;
}

/* The stand-in Nigeria market. Currency comes from the same static table the
   admin form pre-fills from, so the symbol matches what a seeded row would hold.
   `implicit` lets a caller tell it apart from a real one — the admin market list
   uses it to keep prompting for a proper seed. */
function implicitDefault() {
  const cur = currencyFor(DEFAULT_COUNTRY);
  return {
    country: DEFAULT_COUNTRY,
    currencyCode: cur.code,
    currencySymbol: cur.symbol,
    currencyName: cur.name,
    isActive: true,
    implicit: true,
  };
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
  // Last resort is the static table rather than an empty symbol: a bare number
  // where a price should be is worse than a symbol from a known-good source.
  // currencyFor always returns an object — a stub with an empty code for a
  // country it does not know — so test the code rather than the object.
  if (!m) {
    const known = currencyFor(country);
    return known.code ? known : currencyFor(DEFAULT_COUNTRY);
  }
  return { symbol: m.currencySymbol, code: m.currencyCode, name: m.currencyName };
}

module.exports = { markets, market, codes, hasWallet, currency, invalidate };
