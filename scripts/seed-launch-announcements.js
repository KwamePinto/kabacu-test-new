/**
 * Seeds the launch content for Kabacu 2.0:
 *
 *   1. the new-feature popup tour shown to signed-in users
 *   2. the signup-bonus strip under the header, with an expiry
 *   3. switches the signup bonus itself on
 *   4. deactivates leftover test announcements that would otherwise appear
 *      alongside the real ones
 *
 * Idempotent: re-running updates the same rows rather than adding duplicates,
 * matched on title. Safe to run more than once.
 *
 * Refuses to run against the live cluster. Point MONGO_URI at the database you
 * want it applied to.
 *
 *   node scripts/seed-launch-announcements.js
 *   node scripts/seed-launch-announcements.js --dry     (report only)
 */
require('dotenv').config();
const mongoose = require('mongoose');

const DRY = process.argv.includes('--dry');

const URI = process.env.MONGO_URI;
if (!URI) {
  console.log('MONGO_URI is not set.');
  process.exit(1);
}
if (/genjpyi/.test(URI)) {
  console.log('REFUSING: MONGO_URI points at the live cluster. Run this against the');
  console.log('database you intend to seed, not production.');
  process.exit(1);
}

/* The promotion window. Chosen as roughly five weeks out from the 2.0 launch:
   long enough to be worth advertising, short enough to create a reason to sign
   up now. The strip stops rendering by itself once this passes — nothing has to
   remember to take it down. */
const BONUS_ENDS_AT = new Date('2026-09-30T23:59:59Z');
const BONUS_ENDS_LABEL = '30 September 2026';

/* Reward points, scaled to what a point is actually worth here: products award
   a median of about 1,580 RP per purchase, so this is a little under one
   purchase's worth — a real welcome without being extravagant. Change the
   amount under Growth & Rewards if a different figure is wanted. */
const SIGNUP_BONUS_AMOUNT = 1000;
const SIGNUP_BONUS_TYPE = 'rewardpoint';

/* ── The tour ─────────────────────────────────────────────────────────────
   Deliberately free of specific figures. The reward amount, the commission
   percentage and the code prices are all admin-settable and are being tuned;
   copy that quotes a number goes stale the moment one is changed, and a popup
   promising an amount the site does not pay is worse than no popup.

   Ongoing referral commission is NOT mentioned: it is currently switched off,
   and advertising an earning that does not pay out would be a straight
   falsehood. Add a step for it once it is enabled. */
const POPUPS = [
  {
    title: 'Welcome to the new Kabacu',
    eyebrow: "What's new",
    subtitle: 'Same marketplace, rebuilt. Multi-currency wallets, a referral programme that pays, '
      + 'and a faster, clearer experience throughout. Here is a quick tour.',
    ctaLabel: '',
    ctaLink: '',
    order: 1,
  },
  {
    title: 'A wallet in your own currency',
    eyebrow: 'Wallets',
    subtitle: 'Kabacu now runs country by country. Hold a balance in your own currency, see it '
      + 'with the right symbol, and switch between your wallets from the balance card.',
    ctaLabel: 'Open my wallet',
    ctaLink: '/my-wallet',
    order: 2,
  },
  {
    title: 'Invite friends, earn rewards',
    eyebrow: 'Referrals',
    subtitle: 'Share your referral code and earn when the people you invite start shopping. '
      + 'Track every referral and everything you have earned from one page.',
    ctaLabel: 'See my referrals',
    ctaLink: '/referrals',
    order: 3,
  },
  {
    title: 'Make the code your own',
    eyebrow: 'Referrals',
    subtitle: 'Pick a referral code people will actually remember — choose one of ours or request '
      + 'your own. Every code you have ever held keeps working, so old links never break.',
    ctaLabel: 'Choose a code',
    ctaLink: '/referrals',
    order: 4,
  },
  {
    title: 'A signup bonus for new accounts',
    eyebrow: 'Limited time',
    subtitle: 'New accounts get a reward-point bonus, credited as soon as the email address is '
      + 'verified. Running until ' + BONUS_ENDS_LABEL + ' — tell the people you invite.',
    ctaLabel: 'How it works',
    ctaLink: '/faq',
    order: 5,
  },
  {
    title: 'Smoother, clearer, quicker',
    eyebrow: 'Improvements',
    subtitle: 'Statements now show your balance before and after every movement, failed purchases '
      + 'refund and retry cleanly, and search, checkout and the wallet pages are all faster.',
    ctaLabel: 'View my history',
    ctaLink: '/history',
    order: 6,
  },
];

const STRIP = {
  text: 'Signup bonus is active until ' + BONUS_ENDS_LABEL + '. Sign up today.',
  background: '#15a844',
  textColor: '#ffffff',
  countdownEndsAt: BONUS_ENDS_AT,
  order: 1,
  // Titles are the idempotency key, and this one is admin-facing only —
  // the strip renders its `text`, never its title.
  title: 'Signup bonus promo strip',
};

/* Leftover test rows. Matched exactly so a real announcement can never be
   caught by this, and deactivated rather than deleted — reversible from the
   Announcements panel with one toggle if any of them was actually wanted. */
const TEST_TITLES = [
  'This is a test popup banner',
  'Test strip',
  'Title testing',
];

(async () => {
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 30000 });
  console.log('  db: ' + mongoose.connection.name + (DRY ? '   (dry run — nothing will be written)' : '') + '\n');

  const Announcement = require('../server/models/AnnouncementModel');
  const ReferralSettings = require('../server/models/ReferralSettingsModel');
  const Faq = require('../server/models/FaqModel');
  const ADMIN_FAQ_SEED = require('../server/data/adminFaqSeed');

  /* ── 1. Retire the test rows ─────────────────────────────────────────── */
  const stale = await Announcement.find({ title: { $in: TEST_TITLES }, isActive: true }).lean();
  console.log('  test announcements to deactivate: ' + stale.length);
  stale.forEach((a) => console.log('    [' + a.type + '] ' + a.title));
  if (!DRY && stale.length) {
    await Announcement.updateMany(
      { _id: { $in: stale.map((a) => a._id) } },
      { $set: { isActive: false } },
    );
  }

  /* ── 2. The popup tour ───────────────────────────────────────────────── */
  console.log('\n  popups:');
  for (const p of POPUPS) {
    const existing = await Announcement.findOne({ type: 'popup', title: p.title });
    const doc = { ...p, type: 'popup', isActive: true };
    if (DRY) {
      console.log('    ' + (existing ? 'update' : 'create') + '  ' + p.title);
      continue;
    }
    if (existing) {
      await Announcement.updateOne({ _id: existing._id }, { $set: doc });
      console.log('    updated  ' + p.title);
    } else {
      await Announcement.create(doc);
      console.log('    created  ' + p.title);
    }
  }

  /* ── 3. The signup-bonus strip ───────────────────────────────────────── */
  console.log('\n  strip:');
  const existingStrip = await Announcement.findOne({ type: 'strip', title: STRIP.title });
  if (DRY) {
    console.log('    ' + (existingStrip ? 'update' : 'create') + '  ' + STRIP.text);
  } else if (existingStrip) {
    await Announcement.updateOne({ _id: existingStrip._id }, { $set: { ...STRIP, type: 'strip', isActive: true } });
    console.log('    updated  ' + STRIP.text);
  } else {
    await Announcement.create({ ...STRIP, type: 'strip', isActive: true });
    console.log('    created  ' + STRIP.text);
  }

  /* ── 4. The admin manual ─────────────────────────────────────────────────
     The FAQ panel also seeds this the first time it is opened. Doing it here as
     well means the manual is present whether or not anyone has visited that
     page yet — which matters before a demo, where the first person to open it
     should find it already written rather than seeding it by arriving. */
  console.log('\n  admin manual:');
  const manualCount = await Faq.countDocuments({ category: 'admin-dashboard' });
  if (manualCount === 0) {
    if (DRY) {
      console.log('    create  ' + ADMIN_FAQ_SEED.length + ' entries');
    } else {
      await Faq.insertMany(ADMIN_FAQ_SEED);
      console.log('    created  ' + ADMIN_FAQ_SEED.length + ' entries');
    }
  } else {
    console.log('    ' + manualCount + ' entries already present — left alone');
  }

  /* ── 5. Switch the signup bonus on ───────────────────────────────────── */
  const settings = await ReferralSettings.getSettings();
  const before = JSON.stringify(settings.signupBonus);
  console.log('\n  signup bonus before: ' + before);

  if (!DRY) {
    settings.signupBonus = {
      isActive: true,
      rewardType: SIGNUP_BONUS_TYPE,
      amount: SIGNUP_BONUS_AMOUNT,
    };
    await settings.save();
    console.log('  signup bonus after : ' + JSON.stringify(settings.signupBonus));
  } else {
    console.log('  signup bonus after : { isActive: true, rewardType: \''
      + SIGNUP_BONUS_TYPE + '\', amount: ' + SIGNUP_BONUS_AMOUNT + ' }');
  }

  /* The announcement middleware caches for a minute; this process is not the
     web server, so the running site picks the changes up on its own within
     that window. Said explicitly so nobody concludes it did not work. */
  console.log('\n  Done. The live site reflects this within about a minute (announcement cache).');

  if (!DRY) {
    const activePopups = await Announcement.countDocuments({ type: 'popup', isActive: true });
    console.log('  active popups now: ' + activePopups + ' — these are the steps of the tour, in order.');
  }

  await mongoose.disconnect();
})().catch((e) => { console.log('ERR ' + e.stack); process.exit(1); });
