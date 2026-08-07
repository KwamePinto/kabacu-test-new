/**
 * Mark all unhandled ODS-confirmed DAMAGE transactions with apiResponse.odsDelivered = true
 * so they appear on the Flagged Transactions page.
 *
 * Run ONCE: node scripts/mark-ods-damage.js
 * Safe to re-run — it only updates transactions not already marked.
 */
require('dotenv').config();
const mongoose    = require('mongoose');
const Transaction = require('../server/models/TransactionModel');

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('DB connected\n');

  const data      = require('./full-crossref-results.json');
  const unhandled = data.damage.filter(r => !r.alreadyHandled);
  const txIds     = unhandled.map(r => r.txId);

  console.log(`Marking ${txIds.length} transactions as odsDelivered=true...`);

  let updated = 0;
  let skipped = 0;

  for (const id of txIds) {
    const tx = await Transaction.findById(id);
    if (!tx) { console.log(`  NOT FOUND: ${id}`); skipped++; continue; }
    if (tx.apiResponse?.adminDeducted) { console.log(`  SKIP (already deducted): ${id}`); skipped++; continue; }
    if (tx.adminCleared)               { console.log(`  SKIP (cleared): ${id}`); skipped++; continue; }

    tx.apiResponse = { ...(tx.apiResponse || {}), odsDelivered: true };
    tx.markModified('apiResponse');
    await tx.save();
    updated++;
    process.stdout.write(`\r  Updated: ${updated} / ${txIds.length}`);
  }

  console.log(`\n\nDone. Updated: ${updated}  Skipped: ${skipped}`);
  process.exit(0);
}

run().catch(e => { console.error(e.message); process.exit(1); });
