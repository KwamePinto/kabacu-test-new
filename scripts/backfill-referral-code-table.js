#!/usr/bin/env node
/**
 * Populate the ReferralCode table from the codes users already hold.
 *
 * Codes used to live only on `User.referralCode`. Resolution now goes through
 * the code table, so every existing code needs a row or it stops resolving —
 * this is the migration that has to run before the feature is live.
 *
 * Each user's current code becomes their primary row. Kind is inferred from
 * shape: KB######## is a system code, anything else was created by an admin as
 * a special one. Nobody is charged and no code changes.
 *
 * Idempotent — a user who already has a primary row is left alone, so it is
 * safe to re-run after a partial failure.
 *
 *   node scripts/backfill-referral-code-table.js --dry
 *   node scripts/backfill-referral-code-table.js
 */

require('dotenv').config();
const mongoose = require('mongoose');

const DRY = process.argv.includes('--dry');

(async () => {
  const uri = (process.env.MONGO_URI || '').trim();
  if (!uri) {
    console.error('MONGO_URI is not set.');
    process.exit(1);
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 30000 });
  console.log(`connected to ${mongoose.connection.name}${DRY ? '  (dry run)' : ''}\n`);

  const User = require('../server/models/UserModel');
  const ReferralCode = require('../server/models/ReferralCodeModel');
  const SpecialCode = require('../server/models/SpecialReferralCodeModel');
  const { isSystemShape, normalise } = require('../server/services/referralCodeService');

  const withCode = await User.find({
    referralCode: { $exists: true, $nin: [null, ''] },
  }).select('referralCode username email').lean();

  console.log(`users holding a code: ${withCode.length}`);

  const already = await ReferralCode.countDocuments({});
  console.log(`rows already in the code table: ${already}\n`);

  // Codes an admin reserved and assigned are `special`, whatever their shape.
  const assignedSpecials = await SpecialCode.find({ permittedUser: { $ne: null } })
    .select('code permittedUser price')
    .lean();
  const specialByCode = new Map(assignedSpecials.map(s => [normalise(s.code), s]));

  /* Load every existing code row once.
     The first version of this queried per user, which is ~900 sequential round
     trips to a remote Atlas cluster — it had not finished after two minutes.
     Three bulk reads and one bulk write do the same job in seconds. */
  const existingRows = await ReferralCode.find({}).select('code user isPrimary').lean();
  const rowByCode = new Map(existingRows.map(r => [normalise(r.code), r]));
  const primaryUsers = new Set(
    existingRows.filter(r => r.isPrimary).map(r => String(r.user)),
  );

  const toInsert = [];
  let skipped = 0;
  const kinds = { system: 0, special: 0 };
  const problems = [];

  for (const u of withCode) {
    const code = normalise(u.referralCode);
    const byCode = rowByCode.get(code);

    if (byCode || primaryUsers.has(String(u._id))) {
      skipped++;
      // Worth surfacing: the same code against a different user means the
      // unique index on User.referralCode was bypassed at some point.
      if (byCode && String(byCode.user) !== String(u._id)) {
        problems.push(`${code} is on ${u.username} but the code table gives it to another account`);
      }
      continue;
    }

    const special = specialByCode.get(code);
    const kind = special ? 'special' : (isSystemShape(code) ? 'system' : 'special');
    kinds[kind === 'system' ? 'system' : 'special']++;

    toInsert.push({
      code,
      user: u._id,
      kind,
      isPrimary: true,
      // Historic assignments were admin gifts: nothing was paid and no bonus
      // was sold, so both stay at zero rather than being invented.
      pricePaid: 0,
      bonusPercent: 0,
      specialCode: special ? special._id : null,
    });

    // Guard against two users carrying the same code in the source data.
    rowByCode.set(code, { code, user: u._id, isPrimary: true });
    primaryUsers.add(String(u._id));
  }

  let created = 0;
  let clashed = 0;

  if (!DRY && toInsert.length) {
    /* ordered:false so one duplicate does not abandon the rest of the batch.
       insertMany reports per-document failures in err.writeErrors, which is
       what lets a partial success still be counted accurately. */
    try {
      const docs = await ReferralCode.insertMany(toInsert, { ordered: false });
      created = docs.length;
    } catch (err) {
      const writeErrors = (err && err.writeErrors) || [];
      created = toInsert.length - writeErrors.length;
      clashed = writeErrors.length;
      writeErrors.slice(0, 10).forEach(we => {
        const doc = toInsert[we.index] || {};
        problems.push(`${doc.code || '?'} could not be inserted: ${we.errmsg || 'duplicate'}`);
      });
    }
  } else if (DRY) {
    created = toInsert.length;
  }

  console.log(DRY ? '— would do —' : '— done —');
  console.log(`  rows ${DRY ? 'to create' : 'created'}: ${created}`);
  console.log(`    as system codes:  ${kinds.system}`);
  console.log(`    as special codes: ${kinds.special}`);
  console.log(`  already present, left alone: ${skipped}`);
  if (clashed) console.log(`  collided: ${clashed}`);

  if (problems.length) {
    console.log(`
  ${problems.length} thing(s) worth a look:`);
    problems.slice(0, 20).forEach(pr => console.log(`    ${pr}`));
    if (problems.length > 20) console.log(`    …and ${problems.length - 20} more`);
  }

  /* Consistency check: after a real run every held code must resolve through
     the table, because that is the lookup applyReferralCode now uses. A gap
     here means somebody's referral link has stopped working. One bulk read,
     not one per user. */
  if (!DRY) {
    const finalRows = await ReferralCode.find({}).select('code').lean();
    const resolvable = new Set(finalRows.map(r => normalise(r.code)));
    const missing = withCode.filter(u => !resolvable.has(normalise(u.referralCode)));
    console.log(
      `
  verification: ${withCode.length - missing.length}/${withCode.length} held codes resolve through the table` +
      (missing.length ? `  ** ${missing.length} DO NOT — investigate before going live **` : '  ✓'),
    );
    missing.slice(0, 10).forEach(u => console.log(`    unresolvable: ${u.referralCode} (${u.username})`));
  }

  await mongoose.disconnect();
  console.log(DRY ? '\ndry run — nothing was written' : '\ndone');
})().catch(err => {
  console.error('failed:', err.message);
  process.exit(1);
});
