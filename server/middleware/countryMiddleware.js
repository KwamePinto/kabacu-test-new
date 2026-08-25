const { resolveViewerCountry, toName, toFlag, DEFAULT_COUNTRY } = require('../utils/country');
const { getBalance, balancesFor } = require('../utils/wallet');
const marketService = require('../services/marketService');

/**
 * Exposes the viewer's market to every view as:
 *
 *   viewerCountry      { code, walletCountry, profileCountry, signedIn, locked }
 *   viewerCountryName  display name ("Nigeria")
 *   viewerCountryFlag  flag emoji
 *   activeMarket       ISO code of the wallet their money is in
 *   activeCurrency     { symbol, code, name } for that wallet
 *   marketBalance(w)   that wallet's balance out of a wallet document
 *   marketBalances     one row per live market, with this user's balance in each
 *   marketCodes        ISO codes of every live market
 *
 * The split between `viewerCountry.code` and `activeMarket` is the point: a user
 * may browse a market we do not hold money in, and then the two differ. Any
 * balance must be rendered with `activeCurrency`, never with the browsing
 * country's symbol — otherwise a Naira balance gets labelled in Yen the moment
 * someone looks at the Japanese store.
 */
async function countryMiddleware(req, res, next) {
  if (req.originalUrl.startsWith('/admin') || req.originalUrl.startsWith('/api')) {
    return next();
  }

  try {
    const viewer = await resolveViewerCountry(req);
    res.locals.viewerCountry     = viewer;
    res.locals.viewerCountryName = viewer.code ? toName(viewer.code) : '';
    res.locals.viewerCountryFlag = viewer.code ? toFlag(viewer.code) : '';

    const active = viewer.walletCountry || DEFAULT_COUNTRY;
    res.locals.activeMarket   = active;
    res.locals.activeCurrency = await marketService.currency(active);
    res.locals.marketCodes    = await marketService.codes();
    res.locals.marketBalance  = (walletDoc) => getBalance(walletDoc, active);

    /* Per-market balances for the wallet switcher, available on any page that
       shows a balance. This costs no extra query: the market list is cached and
       `res.locals.wallet` was already loaded by loadWallet, which runs earlier
       in the chain. Payment methods are left out — a switcher only needs the
       figures, and the wallet page loads its own richer list for the funding
       form. */
    res.locals.marketBalances = viewer.signedIn
      ? balancesFor(res.locals.wallet, await marketService.markets(), [])
      : [];
  } catch (err) {
    console.error('[country]', err.message);
    res.locals.viewerCountry     = { code: null, walletCountry: null, signedIn: false, locked: false };
    res.locals.viewerCountryName = '';
    res.locals.viewerCountryFlag = '';
    res.locals.activeMarket      = DEFAULT_COUNTRY;
    // A failure here must not leave a balance unlabelled, so fall back to the
    // Naira symbol rather than to an empty string.
    res.locals.activeCurrency    = { symbol: '₦', code: 'NGN', name: 'Naira' };
    res.locals.marketCodes       = [DEFAULT_COUNTRY];
    res.locals.marketBalance     = (walletDoc) => getBalance(walletDoc, DEFAULT_COUNTRY);
    // No switcher rather than a wrong one: with the market list unavailable we
    // cannot say which markets exist, and one option is not a switcher.
    res.locals.marketBalances    = [];
  }

  next();
}

module.exports = countryMiddleware;
