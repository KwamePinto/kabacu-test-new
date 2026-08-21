/**
 * Creates demo referral accounts under one referrer, for testing the
 * /referrals page with realistic data.
 *
 *   node scripts/seed-smoke-referrals.js --email you@example.com
 *   node scripts/seed-smoke-referrals.js --email you@example.com --apply
 *   node scripts/seed-smoke-referrals.js --email you@example.com --clear
 *
 * --clear removes any smoke accounts and referral rows previously created by
 * this script, so the demo can be reset. It only ever touches accounts whose
 * email ends in the sentinel domain below, never a real user.
 *
 * Smoke accounts are created with ObjectId timestamps AFTER the referrer's, so
 * they satisfy the "an older account cannot use a newer account's code" rule.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const User     = require('../server/models/UserModel');
const Referral = require('../server/models/ReferralModel');
const Settings = require('../server/models/ReferralSettingsModel');
const svc      = require('../server/services/referralService');

const SENTINEL = '@smoke.kabacu.test';   // how a demo account is recognised

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : null;
};
const APPLY = process.argv.includes('--apply');
const CLEAR = process.argv.includes('--clear');
const EMAIL = arg('--email');

/* A spread of states so every branch of the page is exercised:
   rewarded rows render green with the amount actually paid; pending rows
   render red with what they would pay if that person purchases. */
const SMOKE = [
  { name: 'Ada Nwosu',      status: 'rewarded' },
  { name: 'Emeka Obi',      status: 'rewarded' },
  { name: 'Fatima Bello',   status: 'rewarded' },
  { name: 'Tunde Adeyemi',  status: 'pending'  },
  { name: 'Ngozi Eze',      status: 'pending'  },
  { name: 'Sadiq Yusuf',    status: 'pending'  },
  { name: 'Blessing Okon',  status: 'pending'  },
];

(async () => {
  if (!EMAIL) throw new Error('Pass --email <referrer email>');
  await mongoose.connect(process.env.MONGO_URI);

  const referrer = await User.findOne({ email: EMAIL.toLowerCase() });
  if (!referrer) throw new Error(`No user with email ${EMAIL}`);

  const code = await svc.ensureReferralCode(referrer._id);
  console.log(`referrer: ${referrer.username} <${referrer.email}>`);
  console.log(`code:     ${code}\n`);

  // ── Clear ────────────────────────────────────────────────────────────────
  if (CLEAR) {
    const smokeUsers = await User.find({ email: new RegExp(SENTINEL.replace('.', '\\.') + '$') }).select('_id').lean();
    const ids = smokeUsers.map(u => u._id);
    const delRefs  = await Referral.deleteMany({ $or: [{ referred: { $in: ids } }, { referrer: referrer._id }] });
    const delUsers = await User.deleteMany({ _id: { $in: ids } });
    console.log(`cleared ${delRefs.deletedCount} referral rows and ${delUsers.deletedCount} smoke accounts`);
    await mongoose.disconnect();
    return;
  }

  const settings = await Settings.getSettings();
  console.log(`reward settings: ${settings.rewardType}` +
              (settings.rewardType === 'data' ? ' (package)' : ` / ${settings.amount}`) +
              `  active=${settings.isActive}`);

  const existing = await Referral.countDocuments({ referrer: referrer._id });
  console.log(`existing referrals for this user: ${existing}`);
  console.log(`\nwould create ${SMOKE.length} smoke accounts:`);
  SMOKE.forEach(s => console.log(`  ${s.name.padEnd(16)} ${s.status}`));

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply.');
    await mongoose.disconnect();
    return;
  }

  console.log('');
  const stamp = Date.now();
  let made = 0;

  for (const s of SMOKE) {
    const slug = s.name.toLowerCase().replace(/[^a-z]+/g, '.');
    const user = await User.create({
      username: s.name,
      email: `${slug}.${stamp}${SENTINEL}`,
      password: 'smoke-account-not-for-login',
      role: 'user',
      isVerified: true,
      country: referrer.country || 'nigeria',
    });
    await svc.ensureReferralCode(user._id);

    const row = {
      referrer: referrer._id,
      referred: user._id,
      codeUsed: code,
      status: s.status,
    };

    // A rewarded row carries the frozen snapshot a real payout would have
    // written, so the page's "claimed" totals are computed from real fields.
    if (s.status === 'rewarded') {
      row.qualifiedAt = new Date();
      row.rewardedAt  = new Date();
      row.rewardType  = settings.rewardType;
      row.rewardAmount = settings.rewardType === 'data' ? 0 : (settings.amount || 0);
      row.rewardProduct = settings.rewardType === 'data' ? settings.dataProduct : null;
      row.rewardNote = 'Smoke demo payout';
    }

    await Referral.create(row);
    made++;
    process.stdout.write(`\r  created ${made}/${SMOKE.length}`);
  }

  const rewarded = SMOKE.filter(s => s.status === 'rewarded').length;
  const pending  = SMOKE.length - rewarded;
  console.log(`\n\ncreated ${made} smoke referrals — ${rewarded} rewarded, ${pending} pending`);

  if (settings.rewardType !== 'data') {
    console.log(`expected on /referrals: claimed=${rewarded * (settings.amount || 0)}, ` +
                `unclaimed=${pending * (settings.amount || 0)}`);
  } else {
    console.log(`expected on /referrals: claimed=${rewarded} bundles, unclaimed=${pending} bundles`);
  }

  await mongoose.disconnect();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
