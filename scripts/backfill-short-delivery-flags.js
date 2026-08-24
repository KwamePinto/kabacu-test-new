/**
 * One-off: stamps historical short deliveries so they appear in the
 * Flagged Transactions → Short Delivery tab and can be resolved there.
 *
 *   node scripts/backfill-short-delivery-flags.js          # report
 *   node scripts/backfill-short-delivery-flags.js --apply  # stamp
 *
 * The live sweep only looks back 48 hours, which is right for ongoing
 * detection but leaves older cases invisible. This runs the full audit once
 * and stamps everything it finds.
 *
 * Idempotent: rows already stamped are skipped, and nothing is marked resolved
 * — an admin still chooses refund or top-up for each one.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Transaction = require('../server/models/TransactionModel');
const { runAudit } = require('../server/services/shortDeliveryAudit');

const APPLY = process.argv.includes('--apply');

(async () => {
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 30000 });
  console.log(`connected — ${APPLY ? 'APPLY' : 'REPORT ONLY'}\n`);

  const r = await runAudit({ onProgress: (p, t) => process.stderr.write(`\r  ODS page ${p}/${t}`) });
  process.stderr.write('\n');

  console.log(`short-delivered found: ${r.totals.rows}   value not delivered: \u20a6${r.totals.lostValue.toLocaleString()}\n`);

  let stamped = 0, already = 0, missing = 0;

  for (const row of r.short) {
    const tx = await Transaction.findOne({ reference: row.reference });
    if (!tx) { missing++; console.log(`  NOT FOUND ${row.reference}`); continue; }

    const ar = tx.apiResponse || {};
    if (ar._shortDelivered) { already++; continue; }

    console.log(`  ${APPLY ? 'stamping' : 'would stamp'} ${row.reference}  ${row.boughtGb}GB->${row.deliveredGb}GB  \u20a6${row.lostValue}`);
    if (!APPLY) { stamped++; continue; }

    tx.apiResponse = {
      ...ar,
      _shortChecked: true,
      _shortCheckedAt: new Date().toISOString(),
      _shortDelivered: true,
      _shortBoughtGb: row.boughtGb,
      _shortDeliveredGb: row.deliveredGb,
      _shortMissingGb: row.missingGb,
      _shortLegs: row.legs,
      _shortLegsOk: row.legsOk,
      _shortLostValue: row.lostValue,
      _shortOdsMessage: row.odsMessage,
      _shortNetwork: row.network,
      _shortPlanType: row.planType,
      _shortBackfilled: true,
    };
    tx.markModified('apiResponse');
    await tx.save();
    stamped++;
  }

  console.log(`\n${APPLY ? 'stamped' : 'would stamp'}: ${stamped}   already stamped: ${already}   not found: ${missing}`);

  if (APPLY) {
    const pending = await Transaction.countDocuments({
      status: 'success',
      'apiResponse._shortDelivered': true,
      'apiResponse._shortResolved': { $ne: true },
      adminCleared: { $ne: true },
    });
    console.log(`tab now shows: ${pending}`);
  } else {
    console.log('\nREPORT ONLY — re-run with --apply.');
  }

  await mongoose.disconnect();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
