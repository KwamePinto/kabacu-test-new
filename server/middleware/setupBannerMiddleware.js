/**
 * Decides whether to show the "finish setting up your account" strip, and
 * what it should say.
 *
 * Verification is optional, which means a user can sail past every step and
 * never think about them again — so something has to remind them, both
 * because the signup bonus depends on it and because an unverified email
 * means a forgotten password cannot be reset.
 *
 * What it nags about is NOT a list kept here. While the promotion is
 * running, the outstanding steps come from referralService.signupBonusProgress
 * — the same call the /signup-bonus page and the claim endpoint read — so a
 * requirement an admin switches on appears in the strip automatically, with
 * no second list to remember to update. The banner used to hardcode email and
 * WhatsApp, which is exactly why adding the Miner ID step left it silently
 * nagging about the wrong things.
 *
 * Cost matters: this runs on every page a signed-in user loads. The order
 * below is deliberate — one lean two-field read answers "is there anything to
 * nag about at all?", and the fuller progress call only happens for users who
 * are actually going to see a strip. Once someone finishes or dismisses it,
 * they are back to a single projected read on every page, forever.
 */
const User = require('../models/UserModel');
const ReferralSettings = require('../models/ReferralSettingsModel');
const referralService = require('../services/referralService');

const SETTINGS_TTL_MS = 60 * 1000;
let settingsCache = null;

async function bonusSettings() {
  if (settingsCache && Date.now() - settingsCache.at < SETTINGS_TTL_MS) return settingsCache.value;
  const doc = await ReferralSettings.getSettings();
  const value = doc.signupBonus || {};
  settingsCache = { at: Date.now(), value };
  return value;
}

/** "a", "a and b", "a, b and c" — read aloud, not comma-spliced. */
function joinLabels(list) {
  if (list.length <= 1) return list[0] || '';
  return list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
}

function rewardLabelFor(bonus) {
  const active = Boolean(bonus.isActive) && Number(bonus.amount) > 0;
  if (!active) return null;
  if (bonus.rewardType === 'rewardpoint') return `${bonus.amount} RP`;
  // 'money' is not offered any more but a settings document configured before
  // that change keeps saying it until an admin next saves the panel.
  if (bonus.rewardType === 'money') return `₦${Number(bonus.amount).toLocaleString()}`;
  return `${bonus.amount} ${bonus.rewardType}`;
}

async function setupBannerMiddleware(req, res, next) {
  res.locals.setupBanner = null;

  if (!req.user || req.originalUrl.startsWith('/admin') || req.originalUrl.startsWith('/api')) {
    return next();
  }

  try {
    const [gate, bonus] = await Promise.all([
      User.findById(req.user.id)
        .select('setupBannerDismissedAt signupBonusPaidAt isVerified whatsappVerifiedAt')
        .lean(),
      bonusSettings(),
    ]);
    if (!gate) return next();

    // Dismissed, or already paid out — nothing worth nagging about.
    if (gate.setupBannerDismissedAt || gate.signupBonusPaidAt) return next();

    const rewardLabel = rewardLabelFor(bonus);

    /* Promotion switched off. The strip still has a reason to exist — an
       unverified email means no password reset — but only for the steps that
       stand up on their own merit. Nagging someone for a Miner ID or for
       referrals when there is no bonus on offer would be asking them to work
       for nothing, so those are deliberately not carried over here. This also
       keeps the switched-off case on the cheap path: no progress call. */
    if (!rewardLabel) {
      const outstanding = [];
      if (bonus.requireEmailVerification !== false && !gate.isVerified) {
        outstanding.push({ label: 'email', href: '/user/verify-otp' });
      }
      if (bonus.requireWhatsappVerification !== false && !gate.whatsappVerifiedAt) {
        outstanding.push({ label: 'WhatsApp', href: '/user/verify-whatsapp' });
      }
      if (!outstanding.length) return next();

      res.locals.setupBanner = {
        rewardLabel: null,
        todo: joinLabels(outstanding.map((o) => o.label)),
        href: outstanding.length === 1 ? outstanding[0].href : '/signup-bonus',
      };
      return next();
    }

    /* Promotion running: the requirements are whatever the admin has toggled
       on, read from the single source of truth rather than restated here. */
    const progress = await referralService.signupBonusProgress(req.user.id);
    if (!progress || progress.claimed) return next();

    const outstanding = progress.objectives.filter((o) => !o.done);
    if (!outstanding.length) {
      /* Everything done but not yet claimed — this is the one case worth
         nagging hardest about, because the money is sitting there waiting on
         a button press. */
      res.locals.setupBanner = {
        rewardLabel,
        ready: true,
        todo: null,
        href: '/signup-bonus',
      };
      return next();
    }

    res.locals.setupBanner = {
      rewardLabel,
      ready: false,
      todo: joinLabels(outstanding.map((o) => o.shortLabel || o.title)),
      /* Straight to the step when only one is left; the overview when there
         are several, or when the single one has no page of its own (referral
         steps are waited on, not visited). */
      href: outstanding.length === 1 && outstanding[0].href ? outstanding[0].href : '/signup-bonus',
    };
  } catch (err) {
    // A reminder strip must never take a page down.
    res.locals.setupBanner = null;
  }

  next();
}

module.exports = setupBannerMiddleware;
