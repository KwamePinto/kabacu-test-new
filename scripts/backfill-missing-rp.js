/**
 * Credits reward points that were lost by the pending-branch bug.
 *
 *   node scripts/backfill-missing-rp.js            # report only
 *   node scripts/backfill-missing-rp.js --apply    # credit + fix the rows
 *   node scripts/backfill-missing-rp.js --apply --include-ambiguous
 *
 * ── The bug ─────────────────────────────────────────────────────────────────
 * When a data purchase timed out, the pending branch set `tx.rpEarned = 0`.
 * The poller credits RP on confirmed delivery but is gated on
 * `if (tx.rpEarned > 0)`, so a purchase that later resolved to success credited
 * nothing and displayed 0 RP forever. Fixed in packagesController; this script
 * repairs the rows already affected.
 *
 * ── Scope ───────────────────────────────────────────────────────────────────
 * CERTAIN    went pending (poller- or admin-resolved), so the zeroing is the
 *            only reason RP is missing and nothing was ever credited. Safe.
 * AMBIGUOUS  completed straight to success, where the code sets rpEarned =
 *            totalRP *and* credits the same figure. A 0 therefore means totalRP
 *            was 0 at the time — the product awarded no RP then. Crediting now
 *            would hand out points that were never earned, so these are
 *            EXCLUDED unless --include-ambiguous is passed.
 * EXCLUDED   admin adjustments and BitToken transfers. Not purchases, and they
 *            carry no product, so they can never be reconstructed.
 *
 * Idempotent: a row already stamped _rpBackfilled is skipped, so re-running
 * cannot double-credit.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const Transaction = require('../server/models/TransactionModel');
const Product     = require('../server/models/ProductsModal');
const User        = require('../server/models/UserModel');

const APPLY     = process.argv.includes('--apply');
const AMBIGUOUS = process.argv.includes('--include-ambiguous');

/** Rebuilds the RP a transaction should have earned, from its product(s). */
function expectedRp(tx, byId) {
  if (Array.isArray(tx.products) && tx.products.length) {
    let sum = 0, known = true;
    for (const line of tx.products) {
      const p = byId.get(String(line.product));
      if (!p) { known = false; continue; }
      sum += (p.reward_point || 0) * (line.quantity || 1);
    }
    return { rp: sum, known };
  }
  if (tx.product) {
    const p = byId.get(String(tx.product));
    return p ? { rp: p.reward_point || 0, known: true } : { rp: 0, known: false };
  }
  return { rp: 0, known: false };
}

function classify(tx) {
  const ar = tx.apiResponse || {};
  const pm = tx.paymentMethod || '';
  if (pm === 'Admin' || pm === 'BitToken Transfer') return 'excluded';
  if (ar._pollerResolved || ar._resolvedByAdmin || ar._timedOut) return 'certain';
  return 'ambiguous';
}

(async () => {
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 30000 });
  console.log(`connected — ${APPLY ? 'APPLY (will write)' : 'REPORT ONLY'}\n`);

  const products = await Product.find().select('reward_point').lean();
  const byId = new Map(products.map(p => [String(p._id), p]));

  const rows = await Transaction.find({
    status: 'success',
    $or: [{ rpEarned: 0 }, { rpEarned: null }, { rpEarned: { $exists: false } }],
  }).select('user reference amount rpEarned apiResponse paymentMethod product products createdAt');

  const targets = [];
  const counts = { certain: 0, ambiguous: 0, excluded: 0, alreadyDone: 0, unresolvable: 0 };

  for (const tx of rows) {
    const ar = tx.apiResponse || {};
    if (ar._rpBackfilled) { counts.alreadyDone++; continue; }

    const kind = classify(tx);
    counts[kind]++;
    if (kind === 'excluded') continue;
    if (kind === 'ambiguous' && !AMBIGUOUS) continue;

    const { rp, known } = expectedRp(tx, byId);
    if (!known || rp <= 0) { counts.unresolvable++; continue; }
    targets.push({ tx, rp, kind });
  }

  const perUser = new Map();
  targets.forEach(t => perUser.set(String(t.tx.user), (perUser.get(String(t.tx.user)) || 0) + t.rp));
  const totalRp = targets.reduce((s, t) => s + t.rp, 0);

  console.log('SCOPE');
  console.log(`  certain (pending-path)        ${counts.certain}`);
  console.log(`  ambiguous (direct success)    ${counts.ambiguous}${AMBIGUOUS ? ' — INCLUDED' : ' — excluded'}`);
  console.log(`  excluded (admin / BitToken)   ${counts.excluded}`);
  console.log(`  already backfilled            ${counts.alreadyDone}`);
  console.log(`  unresolvable                  ${counts.unresolvable}`);
  console.log(`\n  rows to repair:  ${targets.length}`);
  console.log(`  RP to credit:    ${totalRp}`);
  console.log(`  users affected:  ${perUser.size}`);

  if (!APPLY) {
    console.log('\nREPORT ONLY — nothing written. Re-run with --apply.');
    await mongoose.disconnect();
    return;
  }

  console.log('\ncrediting...\n');
  let done = 0, failed = 0;

  for (const { tx, rp, kind } of targets) {
    try {
      // Credit the user, then stamp the row. Order matters: if the stamp fails
      // the credit is visible and a re-run is blocked only by the stamp, so a
      // failure here is reported rather than silently repeated.
      await User.updateOne({ _id: tx.user }, { $inc: { rpBalance: rp } });

      tx.rpEarned = rp;
      tx.apiResponse = {
        ...(tx.apiResponse || {}),
        _rpBackfilled: true,
        _rpBackfilledAt: new Date().toISOString(),
        _rpBackfillReason: `RP lost to the pending-branch zeroing (${kind})`,
        _rpBackfillAmount: rp,
      };
      tx.markModified('apiResponse');
      await tx.save();

      done++;
      if (done % 10 === 0) process.stdout.write(`\r  repaired ${done}/${targets.length}`);
    } catch (err) {
      failed++;
      console.log(`\n  FAILED ${tx.reference}: ${err.message}`);
    }
  }

  console.log(`\n\nrepaired ${done} rows${failed ? `, ${failed} failed` : ''}`);

  // ── Verify ────────────────────────────────────────────────────────────────
  const stillZero = await Transaction.countDocuments({
    status: 'success',
    paymentMethod: { $nin: ['Admin', 'BitToken Transfer'] },
    $or: [{ rpEarned: 0 }, { rpEarned: null }, { rpEarned: { $exists: false } }],
  });
  const stamped = await Transaction.countDocuments({ 'apiResponse._rpBackfilled': true });
  console.log(`\nremaining 0-RP purchase successes: ${stillZero}`);
  console.log(`rows stamped as backfilled:        ${stamped}`);

  await mongoose.disconnect();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
