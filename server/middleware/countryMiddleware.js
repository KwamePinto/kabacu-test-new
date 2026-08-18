const { resolveViewerCountry, toName, toFlag } = require('../utils/country');

/**
 * Exposes the viewer's market to every view as:
 *
 *   viewerCountry      { code, locked }
 *   viewerCountryName  display name ("Nigeria")
 *   viewerCountryFlag  flag emoji
 *
 * `locked` is true for signed-in users — they browse their profile's market
 * only, so the header hides the country picker and shows their country as a
 * plain label rather than something the client script can overwrite.
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
  } catch (err) {
    console.error('[country]', err.message);
    res.locals.viewerCountry     = { code: null, locked: false };
    res.locals.viewerCountryName = '';
    res.locals.viewerCountryFlag = '';
  }

  next();
}

module.exports = countryMiddleware;
