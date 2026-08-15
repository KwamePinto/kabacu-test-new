/**
 * Gives every existing user a referral code.
 *
 *   node scripts/backfill-referral-codes.js          # report only
 *   node scripts/backfill-referral-codes.js --apply  # write codes
 *
 * Safe to re-run: users that already have a code are skipped.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const User = require('../server/models/UserModel');
const { randomCode } = require('../server/services/referralService');

const APPLY = process.argv.includes('--apply');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('connected\n');

  const total   = await User.countDocuments();
  const missing = await User.countDocuments({
    $or: [{ referralCode: { $exists: false } }, { referralCode: null }, { referralCode: '' }],
  });

  console.log(`users total:          ${total}`);
  console.log(`without a code:       ${missing}`);
  console.log(`already have one:     ${total - missing}\n`);

  if (!APPLY) {
    console.log('REPORT ONLY — re-run with --apply to write codes.');
    await mongoose.disconnect();
    return;
  }

  // Preload existing codes so uniqueness is checked in memory rather than with
  // a query per user — this runs over thousands of accounts.
  const taken = new Set(
    (await User.find({ referralCode: { $nin: [null, ''] } }).select('referralCode').lean())
      .map(u => u.referralCode)
  );

  const cursor = User.find({
    $or: [{ referralCode: { $exists: false } }, { referralCode: null }, { referralCode: '' }],
  }).select('_id').cursor();

  let ops = [], done = 0, failed = 0;

  async function flush() {
    if (!ops.length) return;
    await User.bulkWrite(ops, { ordered: false });
    done += ops.length;
    ops = [];
    process.stdout.write(`\r  written: ${done}/${missing}`);
  }

  for await (const u of cursor) {
    let code = null;
    for (let i = 0; i < 12; i++) {
      const candidate = randomCode();
      if (!taken.has(candidate)) { code = candidate; taken.add(candidate); break; }
    }
    if (!code) { failed++; continue; }

    ops.push({ updateOne: { filter: { _id: u._id }, update: { $set: { referralCode: code } } } });
    if (ops.length === 500) await flush();
  }
  await flush();

  console.log(`\n\nwrote ${done} codes` + (failed ? `, ${failed} failed to allocate` : ''));

  const stillMissing = await User.countDocuments({
    $or: [{ referralCode: { $exists: false } }, { referralCode: null }, { referralCode: '' }],
  });
  const distinct = (await User.distinct('referralCode', { referralCode: { $nin: [null, ''] } })).length;
  const withCode = await User.countDocuments({ referralCode: { $nin: [null, ''] } });

  console.log(`still without a code: ${stillMissing}`);
  console.log(`codes unique:         ${distinct === withCode ? 'yes' : 'NO — ' + withCode + ' users, ' + distinct + ' distinct'}`);

  await mongoose.disconnect();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
