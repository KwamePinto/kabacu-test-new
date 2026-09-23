const adminLayout = 'layouts/adminLayout';
const SiteSettings = require('../../models/SiteSettingsModel');
const maintenanceMiddleware = require('../../middleware/maintenanceMiddleware');
const { authenticateAdminUser } = require('../../config/authMiddleware');

exports.viewSettings = [authenticateAdminUser, async (req, res) => {
  try {
    const settings = await SiteSettings.getSettings();
    res.render('adminview/settings', {
      layout: adminLayout,
      settings,
      query: req.query,
    });
  } catch (err) {
    console.error('[settingsController.viewSettings]', err);
    res.status(500).send('Error loading settings.');
  }
}];

exports.updateSettings = [authenticateAdminUser, async (req, res) => {
  try {
    const settings = await SiteSettings.getSettings();

    // ── RP Transfer ────────────────────────────────────────────────────────────
    settings.rpTransferEnabled = req.body.rpTransferEnabled === 'true';
    const rpMsg = (req.body.rpTransferSuspendedMessage || '').trim();
    if (rpMsg) settings.rpTransferSuspendedMessage = rpMsg;

    // ── BTT Topup ──────────────────────────────────────────────────────────────
    settings.bttTopupEnabled = req.body.bttTopupEnabled === 'true';
    const bttMsg = (req.body.bttTopupSuspendedMessage || '').trim();
    if (bttMsg) settings.bttTopupSuspendedMessage = bttMsg;

    // ── USDT Topup ─────────────────────────────────────────────────────────────
    settings.usdtTopupEnabled = req.body.usdtTopupEnabled === 'true';
    const usdtMsg = (req.body.usdtTopupSuspendedMessage || '').trim();
    if (usdtMsg) settings.usdtTopupSuspendedMessage = usdtMsg;

    // ── OurDataStore ADEX ID ───────────────────────────────────────────────────
    const adexId = (req.body.ourdatastoreAdexId || '').trim();
    if (adexId) settings.ourdatastoreAdexId = adexId;

    // ── Maintenance mode ───────────────────────────────────────────────────────
    settings.maintenanceModeEnabled = req.body.maintenanceModeEnabled === 'true';
    const maintMsg = (req.body.maintenanceMessage || '').trim();
    if (maintMsg) settings.maintenanceMessage = maintMsg;

    // Whether a signed-in tester (see testerAuthController.js) bypasses the
    // block above. Same toggle pattern as the rest of this form — checked
    // submits 'true', unchecked submits nothing at all, so a missing field
    // reads as false. Defaults true at the schema level (see
    // SiteSettingsModel.js), so the checkbox starts checked and this line
    // only ever turns it false once an admin actually unchecks it.
    settings.testingBypassMaintenanceEnabled = req.body.testingBypassMaintenanceEnabled === 'true';

    // ── Upcoming maintenance banner ────────────────────────────────────────────
    settings.maintenanceBannerEnabled = req.body.maintenanceBannerEnabled === 'true';
    const bannerMsg = (req.body.maintenanceBannerMessage || '').trim();
    if (bannerMsg) settings.maintenanceBannerMessage = bannerMsg;

    await settings.save();

    // Flush the 30-second middleware cache so changes take effect immediately
    maintenanceMiddleware.invalidateCache();

    const section = (req.body.section || '').trim();
    const qs = section ? `?saved=1&section=${encodeURIComponent(section)}` : '?saved=1';
    res.redirect('/admin/settings' + qs);
  } catch (err) {
    console.error('[settingsController.updateSettings]', err);
    const section = (req.body.section || '').trim();
    const qs = section ? `?error=1&section=${encodeURIComponent(section)}` : '?error=1';
    res.redirect('/admin/settings' + qs);
  }
}];
