/**
 * Re-issues every user's referral code in the KB######## format.
 *
 *   node scripts/migrate-referral-codes-to-kb.js          # report only
 *   node scripts/migrate-referral-codes-to-kb.js --apply  # rewrite codes
 *
 * Codes already in the new shape are left alone, so this is re-runnable and
 * also fills in anyone still missing a code.
 *
 * ── Read this before running it on production ───────────────────────────────
 * Referral codes are handed out to real people. Rewriting them INVALIDATES
 * every code already shared — anyone who saved a friend's old code can no
 * longer redeem it. Existing Referral rows are unaffected: they store the code
 * that was used at the time (codeUsed) and link by user id, so credited history
 * and pending payouts survive intact.
 *
 * Codes reserved for sale (SpecialReferralCode) are never generated here, and
 * any user already holding an assigned special code keeps it — a premium code
 * must not be clobbered by a system one.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const User        = require('../server/models/UserModel');
const SpecialCode = require('../server/models/SpecialReferralCodeModel');
const { randomCode, isSystemCode } = require('../server/services/referralService');

const APPLY = process.argv.includes('--apply');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  console.log(`connected — ${APPLY ? 'APPLY (will rewrite codes)' : 'REPORT ONLY'}\n`);

  const total = await User.countDocuments();

  // Codes an admin is holding for sale, plus any already handed to a user:
  // neither may be overwritten or re-generated.
  const specials      = await SpecialCode.find().select('code permittedUser').lean();
  const reservedCodes = new Set(specials.map(s => s.code));
  const specialHolders = new Set(
    specials.filter(s => s.permittedUser).map(s => String(s.permittedUser))
  );

  const users = await User.find().select('_id referralCode').lean();

  const alreadyNew = users.filter(u => isSystemCode(u.referralCode)).length;
  const holdsSpecial = users.filter(u => specialHolders.has(String(u._id))).length;
  const needsChange = users.filter(u =>
    !isSystemCode(u.referralCode) && !specialHolders.has(String(u._id))
  );

  console.log(`users total:                 ${total}`);
  console.log(`already KB########:          ${alreadyNew}`);
  console.log(`holding a special code:      ${holdsSpecial}  (left untouched)`);
  console.log(`to be re-issued:             ${needsChange.length}`);
  console.log(`reserved codes to avoid:     ${reservedCodes.size}\n`);

  if (!APPLY) {
    console.log('REPORT ONLY — re-run with --apply to rewrite.');
    console.log('WARNING: applying invalidates every referral code already shared.');
    await mongoose.disconnect();
    return;
  }

  // Track allocations in memory so uniqueness holds within this run too.
  const taken = new Set([
    ...users.map(u => u.referralCode).filter(Boolean),
    ...reservedCodes,
  ]);

  let ops = [], done = 0, failed = 0;

  async function flush() {
    if (!ops.length) return;
    await User.bulkWrite(ops, { ordered: false });
    done += ops.length;
    ops = [];
    process.stdout.write(`\r  re-issued: ${done}/${needsChange.length}`);
  }

  for (const u of needsChange) {
    let code = null;
    for (let i = 0; i < 20; i++) {
      const candidate = randomCode();
      if (!taken.has(candidate)) { code = candidate; taken.add(candidate); break; }
    }
    if (!code) { failed++; continue; }

    ops.push({ updateOne: { filter: { _id: u._id }, update: { $set: { referralCode: code } } } });
    if (ops.length === 500) await flush();
  }
  await flush();

  console.log(`\n\nre-issued ${done} codes` + (failed ? `, ${failed} could not be allocated` : ''));

  // ── Verify ────────────────────────────────────────────────────────────────
  const withCode  = await User.countDocuments({ referralCode: { $nin: [null, ''] } });
  const distinct  = (await User.distinct('referralCode', { referralCode: { $nin: [null, ''] } })).length;
  const badShape  = (await User.find({ referralCode: { $nin: [null, ''] } })
    .select('_id referralCode').lean())
    .filter(u => !isSystemCode(u.referralCode) && !specialHolders.has(String(u._id)));

  console.log(`\nusers with a code:  ${withCode}`);
  console.log(`codes unique:       ${distinct === withCode ? 'yes' : `NO — ${withCode} users, ${distinct} distinct`}`);
  console.log(`wrong shape left:   ${badShape.length}`);
  if (badShape.length) badShape.slice(0, 5).forEach(u => console.log(`  ${u._id} ${u.referralCode}`));

  await mongoose.disconnect();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
