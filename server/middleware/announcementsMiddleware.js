const Announcement = require('../models/AnnouncementModel');

/**
 * Makes the live announcements available to every view as
 * `announcements = { banners, strips, popups }`.
 *
 * Results are cached in memory for a short window so a page render costs at
 * most one query per CACHE_TTL_MS rather than one per request. Admin writes
 * call clearCache() so changes show up immediately.
 */

const CACHE_TTL_MS = 60 * 1000;
let _cache = null;
let _cachedAt = 0;

function clearCache() {
  _cache = null;
  _cachedAt = 0;
}

async function loadAll() {
  if (_cache && Date.now() - _cachedAt < CACHE_TTL_MS) return _cache;

  const docs = await Announcement.find({ isActive: true })
    .sort({ order: 1, createdAt: 1 })
    .lean();

  _cache = docs;
  _cachedAt = Date.now();
  return docs;
}

/**
 * Expiry is evaluated per request, not per cache fill — otherwise a countdown
 * that runs out mid-window would keep rendering for up to a minute.
 */
function live(docs, type) {
  const now = Date.now();
  return docs.filter(d =>
    d.type === type &&
    (!d.countdownEndsAt || new Date(d.countdownEndsAt).getTime() > now)
  );
}

async function announcementsMiddleware(req, res, next) {
  // Admin pages render their own data and never show public announcements
  if (req.originalUrl.startsWith('/admin') || req.originalUrl.startsWith('/api')) {
    res.locals.announcements = { banners: [], strips: [], popups: [] };
    return next();
  }

  try {
    const docs = await loadAll();
    res.locals.announcements = {
      banners: live(docs, 'banner'),
      strips:  live(docs, 'strip'),
      popups:  live(docs, 'popup'),
    };
  } catch (err) {
    // Never let an announcement failure take down a page
    console.error('[announcements]', err.message);
    res.locals.announcements = { banners: [], strips: [], popups: [] };
  }

  next();
}

module.exports = announcementsMiddleware;
module.exports.clearCache = clearCache;
