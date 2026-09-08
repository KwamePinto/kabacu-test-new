/**
 * Decides whether to show the "finish setting up your account" strip.
 *
 * Verification is optional now, which means a user can sail past both steps
 * and never think about them again — so something has to remind them, both
 * because the signup bonus depends on it and because an unverified email
 * means a forgotten password cannot be reset.
 *
 * Cost matters here: this runs on every page a signed-in user loads. So it is
 * one lean projection of four fields, and the settings document — which
 * changes only when an admin saves the panel — is cached rather than read
 * each time.
 */
const User = require('../models/UserModel');
const ReferralSettings = require('../models/ReferralSettingsModel');

const SETTINGS_TTL_MS = 60 * 1000;
let settingsCache = null;

async function bonusSettings() {
  if (settingsCache && Date.now() - settingsCache.at < SETTINGS_TTL_MS) return settingsCache.value;
  const doc = await ReferralSettings.getSettings();
  const value = doc.signupBonus || {};
  settingsCache = { at: Date.now(), value };
  return value;
}

async function setupBannerMiddleware(req, res, next) {
  res.locals.setupBanner = null;

  if (!req.user || req.originalUrl.startsWith('/admin') || req.originalUrl.startsWith('/api')) {
    return next();
  }

  try {
    const [user, bonus] = await Promise.all([
      User.findById(req.user.id)
        .select('isVerified whatsappVerifiedAt setupBannerDismissedAt signupBonusPaidAt')
        .lean(),
      bonusSettings(),
    ]);
    if (!user) return next();

    // Dismissed, or already paid out — nothing worth nagging about.
    if (user.setupBannerDismissedAt || user.signupBonusPaidAt) return next();

    const needEmail = bonus.requireEmailVerification !== false && !user.isVerified;
    const needWhatsapp = bonus.requireWhatsappVerification !== false && !user.whatsappVerifiedAt;
    if (!needEmail && !needWhatsapp) return next();

    const active = Boolean(bonus.isActive) && Number(bonus.amount) > 0;
    const label = !active ? null
      : bonus.rewardType === 'rewardpoint' ? `${bonus.amount} RP`
      : bonus.rewardType === 'money' ? `₦${Number(bonus.amount).toLocaleString()}`
      : `${bonus.amount} ${bonus.rewardType}`;

    res.locals.setupBanner = {
      needEmail,
      needWhatsapp,
      // Only mention a reward that is actually on offer; otherwise the strip
      // makes the honest case for verifying (password recovery) instead of
      // dangling a bonus that is switched off.
      rewardLabel: label,
      // Send them straight to the single outstanding step when there is only
      // one, and to the overview when there are two.
      href: needEmail && needWhatsapp ? '/signup-bonus'
        : needEmail ? '/user/verify-otp'
        : '/user/verify-whatsapp',
    };
  } catch (err) {
    // A reminder strip must never take a page down.
    res.locals.setupBanner = null;
  }

  next();
}

module.exports = setupBannerMiddleware;
