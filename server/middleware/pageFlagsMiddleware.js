const PageFlag = require('../models/PageFlagModel');
const { MANAGED_PAGES_BY_KEY } = require('../data/managedPages');

/**
 * Per-page "enabled / coming soon" gate — the generalized, multi-page version
 * of gamesMiddleware.js's single `gamesEnabled` flag. Cached the same way
 * (one query per CACHE_TTL_MS for every key at once, rather than per
 * request), with the admin controller calling clearCache() after a save so a
 * toggle shows up immediately instead of waiting out the TTL.
 */

const CACHE_TTL_MS = 60 * 1000;
let _cache = null; // Map<key, flagDoc-shaped plain object>
let _cachedAt = 0;

function clearCache() {
  _cache = null;
  _cachedAt = 0;
}

async function loadAll() {
  if (_cache !== null && Date.now() - _cachedAt < CACHE_TTL_MS) return _cache;

  const map = new Map();
  try {
    const docs = await PageFlag.find().lean();
    docs.forEach((d) => map.set(d.key, d));
  } catch (err) {
    // Fail open — a settings-lookup hiccup shouldn't take a page down for
    // everyone. An empty map means every key below falls through to its
    // "enabled, no custom content" default.
    console.error('[pageFlags]', err.message);
  }
  _cache = map;
  _cachedAt = Date.now();
  return _cache;
}

/** A page with no document yet is enabled with no custom coming-soon content. */
async function getFlag(key) {
  const map = await loadAll();
  return map.get(key) || { key, enabled: true, comingSoonTitle: '', comingSoonMessage: '', comingSoonImage: '' };
}

/**
 * Express middleware factory. Chain directly on a route:
 *   router.get('/course-category', pageGate('courses'), getCategory.courseCategory)
 *
 * A signed-in tester (server/models/TesterModel.js, req.session.tester —
 * exactly the same session the maintenance-mode bypass checks in
 * maintenanceMiddleware.js) always reaches the real page regardless of the
 * flag, so testers can QA a feature before it's made public.
 */
function pageGate(key) {
  return async (req, res, next) => {
    const flag = await getFlag(key);
    if (flag.enabled !== false) return next();

    const isTester = !!(req.session && req.session.tester && req.session.tester.email);
    if (isTester) return next();

    const page = MANAGED_PAGES_BY_KEY[key];
    return res.render('webview/comingSoon', {
      layout: false,
      pageLabel: (page && page.label) || '',
      title: flag.comingSoonTitle || '',
      message: flag.comingSoonMessage || '',
      image: flag.comingSoonImage || '',
    });
  };
}

module.exports = { getFlag, clearCache, pageGate };
