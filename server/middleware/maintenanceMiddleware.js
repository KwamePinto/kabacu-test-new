const SiteSettings = require('../models/SiteSettingsModel');
const { renderMaintenanceMessage, firstCountdownTarget } = require('../utils/maintenanceTokens');

let _cache = null;
let _cacheAt = 0;
const CACHE_TTL = 30 * 1000;

async function getCachedSettings() {
  if (_cache && Date.now() - _cacheAt < CACHE_TTL) return _cache;
  _cache = await SiteSettings.getSettings();
  _cacheAt = Date.now();
  return _cache;
}

function invalidateCache() {
  _cache = null;
  _cacheAt = 0;
}

async function maintenanceMiddleware(req, res, next) {
  const url = req.originalUrl.split('?')[0];

  // Always pass through: admin panel, the whole /command family (admin
  // login + 2FA, and the tester login portal — a tester must always be able
  // to reach and use /command/testing regardless of maintenance state; what
  // a signed-in tester can do past this point still depends on
  // testingBypassMaintenanceEnabled below), API routes, static uploads.
  //
  // This also fixes a standing gap: the old check only matched the bare
  // string "/command", so /command/verify (admin 2FA) was never actually
  // exempted — an admin mid-login during maintenance would have hit the
  // maintenance page instead of the code-entry form.
  if (
    url.startsWith('/admin') ||
    url.startsWith('/command') ||
    url.startsWith('/api') ||
    url.startsWith('/uploads')
  ) {
    return next();
  }

  try {
    const settings = await getCachedSettings();

    // Set banner locals for all public pages when banner is active. The
    // banner's own text is free-form now (see SiteSettings.maintenanceBannerMessage
    // and maintenanceTokens.js) — if it contains a {{countdown:...}} token,
    // that target is what auto-hides the banner once it has passed, same as
    // the old dedicated scheduledAt field used to. No countdown token means
    // no auto-expiry: the toggle alone controls visibility.
    if (settings.maintenanceBannerEnabled && settings.maintenanceBannerMessage) {
      const target = firstCountdownTarget(settings.maintenanceBannerMessage);
      if (!target || target.getTime() > Date.now()) {
        res.locals.maintenanceBanner = {
          // Same pre-rendered-HTML approach as the maintenance page itself —
          // see the messageHtml comment further down.
          messageHtml: renderMaintenanceMessage(settings.maintenanceBannerMessage),
        };
      }
    }

    // A signed-in tester (see testerAuthController.js) — made available to
    // every view so the main layout can show a "Testing Mode" indicator
    // regardless of whether maintenance is even on right now.
    const hasTesterSession = !!(req.session && req.session.tester && req.session.tester.email);
    res.locals.isTesterSession = hasTesterSession;
    res.locals.testerEmail = hasTesterSession ? req.session.tester.email : null;

    // Block the site if maintenance mode is on — unless this is a tester
    // session and the admin has left the bypass switched on.
    if (settings.maintenanceModeEnabled) {
      const bypassAllowed = hasTesterSession && settings.testingBypassMaintenanceEnabled !== false;
      if (!bypassAllowed) {
        const rawMessage = settings.maintenanceMessage ||
          "We're performing scheduled maintenance. We'll be back up shortly.";
        return res.status(503).render('webview/maintenance', {
          layout: false,
          // Pre-rendered to HTML here so the view can output it unescaped —
          // see server/utils/maintenanceTokens.js for what that HTML can
          // contain (only escaped text and inert token placeholder spans).
          messageHtml: renderMaintenanceMessage(rawMessage),
        });
      }
    }

    next();
  } catch (err) {
    console.error('[maintenanceMiddleware]', err.message);
    next(); // fail open — never break the site if DB is unreachable
  }
}

maintenanceMiddleware.invalidateCache = invalidateCache;
module.exports = maintenanceMiddleware;
