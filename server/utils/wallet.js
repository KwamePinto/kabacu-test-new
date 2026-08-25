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
  const before = await Wallet.findOneAndUpdate(
    { user: userId },
    { $inc: { [path]: Number(delta) || 0 } },
    { new: false },
  );
  if (!before) return null;

  const balanceBefore = getBalance(before, country);
  return {
    balanceBefore,
    balanceAfter: balanceBefore + (Number(delta) || 0),
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
};
