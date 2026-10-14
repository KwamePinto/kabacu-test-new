const { toCode, toName, toFlag, DEFAULT_COUNTRY } = require('./country');

/**
 * One way in and out of a user's per-country money.
 *
 * Nigeria lives in `wallet.balances.NAIRA` and every other market lives in
 * `wallet.countryBalances`. That split exists for a reason (see WalletModal.js):
 * the Naira field is read and written in over a hundred places, so it stays put
 * and this module hides the difference. Call these helpers instead of touching
 * either field, and adding a market never needs a migration.
 */

const NAIRA_PATH = 'balances.NAIRA';

/**
 * Snap a monetary value to 2 decimal places (kobo/cent precision) by cutting
 * off anything past the 2nd decimal — never rounding up. 2.989 becomes 2.98,
 * not 2.99; a user should never see money appear that wasn't there.
 *
 * Repeated `$inc` operations on a balance accumulate IEEE-754 drift over time
 * (e.g. a balance that should read exactly 500 settles at 499.99999999999994).
 * That is invisible anywhere the UI truncates for display, but a strict
 * numeric comparison against it is not — a user with "exactly" enough money
 * to buy something would be told their balance is insufficient. Truncate
 * here, once, rather than at each comparison site.
 *
 * Naive `Math.trunc(n * 100) / 100` is NOT safe here: a perfectly clean value
 * like 4.31 is itself stored as the double 4.30999999999999960920..., so
 * multiplying by 100 and truncating silently shaves off a real cent
 * (4.31 -> 4.3) that was never actually missing. `toFixed(10)` first resolves
 * that representation noise back to the clean decimal (doubles only carry
 * ~15-17 significant digits, so anything this deep is noise, never real
 * drift — genuine drift from accumulated `$inc` calls runs several orders of
 * magnitude larger, e.g. 259.72133616243434). Only once that noise is gone
 * is it safe to cut the string at 2 decimals without rounding.
 */
function truncate2(n) {
  n = Number(n) || 0;
  const sign = n < 0 ? -1 : 1;
  const fixed = Math.abs(n).toFixed(10);
  const dot = fixed.indexOf('.');
  return sign * parseFloat(fixed.slice(0, dot + 3));
}

/** True when `balance` covers `amount`, tolerant of float drift below cent precision. */
function sufficientFunds(balance, amount) {
  return truncate2(balance) >= truncate2(amount);
}

/**
 * The aggregation-pipeline equivalent of `truncate2`, for use inside a
 * `findOneAndUpdate`/`$expr` pipeline. Mongo's own `$trunc` operates on the
 * raw double and has the exact same noise problem described on `truncate2`
 * (plain `$trunc` turns 4.31 into 4.3) — routing through `$toDecimal` first
 * round-trips at Decimal128's ~15 significant digits, which resolves that
 * noise the same way `toFixed(10)` does in JS, before truncating for real.
 */
function truncExpr(expr) {
  return { $toDouble: { $trunc: [{ $toDecimal: expr }, 2] } };
}

/** Normalise anything country-shaped to an ISO code, defaulting to Nigeria. */
function marketOf(value) {
  return toCode(value) || DEFAULT_COUNTRY;
}

function isNigeria(value) {
  return marketOf(value) === DEFAULT_COUNTRY;
}

/**
 * Dotted path to a market's balance, for `$inc`/`$set` in an atomic update.
 * Use this rather than building the string at the call site — it is the only
 * place that knows Nigeria is stored somewhere else.
 */
function balancePath(country) {
  const code = marketOf(country);
  return code === DEFAULT_COUNTRY ? NAIRA_PATH : `countryBalances.${code}`;
}

/**
 * A market's balance as a number. Missing entries read as 0, which is correct:
 * a user who has never held Cedis has no Cedis.
 *
 * Works on both hydrated documents (Map) and `.lean()` results (plain object),
 * because controllers pass both.
 */
function getBalance(wallet, country) {
  if (!wallet) return 0;
  const code = marketOf(country);

  if (code === DEFAULT_COUNTRY) {
    return Number((wallet.balances && wallet.balances.NAIRA) || 0);
  }

  const cb = wallet.countryBalances;
  if (!cb) return 0;
  // Map on a hydrated doc, plain object after .lean()
  const raw = typeof cb.get === 'function' ? cb.get(code) : cb[code];
  return Number(raw || 0);
}

/** Set a market's balance on a hydrated document. Caller still saves. */
function setBalance(wallet, country, amount) {
  const code = marketOf(country);
  const value = Number(amount) || 0;

  if (code === DEFAULT_COUNTRY) {
    wallet.balances.NAIRA = value;
    return value;
  }

  if (!wallet.countryBalances) wallet.countryBalances = new Map();
  if (typeof wallet.countryBalances.set === 'function') {
    wallet.countryBalances.set(code, value);
  } else {
    wallet.countryBalances[code] = value;
  }
  // Mongoose does not always notice a mutation inside a Map.
  if (typeof wallet.markModified === 'function') wallet.markModified('countryBalances');
  return value;
}

/**
 * Move money in a market atomically and report the balance either side of it.
 *
 * `findOneAndUpdate` with `$inc` and `new: false` is what makes this race-free:
 * the returned document is the pre-update state, so `before` is the balance the
 * increment actually applied to — not a value read seconds earlier. The account
 * statement depends on that being true.
 *
 * Returns null when the wallet does not exist, so callers can tell "no wallet"
 * apart from "moved zero".
 */
async function applyDelta(Wallet, userId, country, delta) {
  const path = balancePath(country);
  const amount = truncate2(delta);
  // A pipeline update (array form) truncates the new value atomically in the
  // same operation that applies it, so this write can never itself introduce
  // drift — unlike a plain `$inc`, which adds the raw float as-is.
  const before = await Wallet.findOneAndUpdate(
    { user: userId },
    [{ $set: { [path]: truncExpr({ $add: [{ $ifNull: [`$${path}`, 0] }, amount] }) } }],
    { new: false, updatePipeline: true },
  );
  if (!before) return null;

  const balanceBefore = getBalance(before, country);
  return {
    balanceBefore,
    balanceAfter: truncate2(balanceBefore + amount),
    market: marketOf(country),
  };
}

/**
 * Every market balance a user holds, for the wallet switcher.
 *
 * Driven by the admin's country wallet list rather than by what the user
 * happens to hold, so a newly created market shows up immediately at zero
 * instead of appearing only after the first payment.
 *
 * `methods` is the flat PaymentMethod list for every market; it gets grouped by
 * country here so the view can render a market's funding options without a
 * second query per market.
 */
function balancesFor(wallet, countryWallets, methods) {
  const byCountry = {};
  (methods || []).forEach(m => {
    const c = marketOf(m.country);
    (byCountry[c] = byCountry[c] || []).push(m);
  });

  return (countryWallets || []).map(cw => ({
    country:        cw.country,
    countryName:    toName(cw.country),
    flag:           toFlag(cw.country),
    currencyCode:   cw.currencyCode,
    currencySymbol: cw.currencySymbol,
    currencyName:   cw.currencyName,
    balance:        getBalance(wallet, cw.country),
    paymentMethods: byCountry[marketOf(cw.country)] || [],
  }));
}

module.exports = {
  NAIRA_PATH,
  marketOf,
  isNigeria,
  balancePath,
  getBalance,
  setBalance,
  applyDelta,
  balancesFor,
  truncate2,
  sufficientFunds,
  truncExpr,
};
