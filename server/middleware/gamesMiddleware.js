const SiteSettings = require('../models/SiteSettingsModel');

/**
 * Makes `gamesEnabled` available to every view — the header nav link, the
 * mobile category circle, the desktop category card, and the games page
 * itself all gate on it. Cached the same way announcementsMiddleware caches
 * announcements: one query per CACHE_TTL_MS rather than per request, with
 * the admin toggle calling clearCache() so a flip shows up immediately.
 */

const CACHE_TTL_MS = 60 * 1000;
let _cache = null;
let _cachedAt = 0;

function clearCache() {
  _cache = null;
  _cachedAt = 0;
}

async function loadEnabled() {
  if (_cache !== null && Date.now() - _cachedAt < CACHE_TTL_MS) return _cache;

  try {
    const settings = await SiteSettings.getSettings();
    _cache = settings.gamesEnabled !== false;
  } catch (err) {
    // Fail open — a settings-lookup hiccup shouldn't take the nav link down.
    console.error('[games]', err.message);
    _cache = true;
  }
  _cachedAt = Date.now();
  return _cache;
}

async function gamesMiddleware(req, res, next) {
  res.locals.gamesEnabled = await loadEnabled();
  next();
}

module.exports = gamesMiddleware;
module.exports.clearCache = clearCache;
