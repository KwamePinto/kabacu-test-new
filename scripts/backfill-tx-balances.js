/**
 * Backfill balanceBefore / balanceAfter on Transaction documents where the
 * admin stored those values inside apiResponse but never set the top-level
 * model fields.  Covers:
 *   - Admin deductions  (apiResponse.adminDeducted = true)
 *   - Old flagged-tab refunds  (apiResponse.adminRefunded = true, _resolvedByAdmin = true)
 */
require('dotenv').config();
const mongoose    = require('mongoose');
const Transaction = require('../server/models/TransactionModel');

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('DB connected\n');

  // ── 1. Admin deductions ──────────────────────────────────────────
  const deductions = await Transaction.find({
    'apiResponse.adminDeducted': true,
    balanceBefore: { $exists: false },
  });

  console.log(`Admin deductions missing top-level balance: ${deductions.length}`);
  let dFixed = 0;
  for (const tx of deductions) {
    const bBefore = tx.apiResponse?.balanceBefore;
    const bAfter  = tx.apiResponse?.balanceAfter;
    if (bBefore == null && bAfter == null) { console.log(`  SKIP ${tx._id} — no data in apiResponse either`); continue; }
    tx.balanceBefore = bBefore ?? null;
    tx.balanceAfter  = bAfter  ?? null;
    await tx.save();
    dFixed++;
  }
  console.log(`  Fixed: ${dFixed}\n`);

  // ── 2. Old resolved refunds (flagged-tab "Refund User") ──────────
  const oldRefunds = await Transaction.find({
    'apiResponse.adminRefunded': true,
    'apiResponse._resolvedByAdmin': true,
    balanceBefore: { $exists: false },
  });

  console.log(`Old resolved refunds missing top-level balance: ${oldRefunds.length}`);
  let rFixed = 0;
  for (const tx of oldRefunds) {
    const bBefore = tx.apiResponse?.balanceBefore;
    const bAfter  = tx.apiResponse?.balanceAfter;
    if (bBefore == null && bAfter == null) { console.log(`  SKIP ${tx._id} — no data in apiResponse either`); continue; }
    tx.balanceBefore = bBefore ?? null;
    tx.balanceAfter  = bAfter  ?? null;
    await tx.save();
    rFixed++;
  }
  console.log(`  Fixed: ${rFixed}\n`);

  console.log('Done.');
  process.exit(0);
}

run().catch(err => { console.error(err); process.exit(1); });
