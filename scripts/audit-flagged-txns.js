'use strict';
/**
 * Audit the flagged-transactions table.
 * Categorises every entry and auto-clears the ones that are safe to remove
 * (post-fix clean OurDataStore rejections where the wallet was properly refunded).
 *
 * Usage: node scripts/audit-flagged-txns.js
 * Add --dry-run to print the report without writing anything.
 */

require('dotenv').config();
const mongoose    = require('mongoose');
const Transaction = require('../server/models/TransactionModel');
require('../server/models/UserModel'); // register User schema for populate

const DRY_RUN = process.argv.includes('--dry-run');

// ── Filters (mirrors damageControlController.js) ─────────────────────────────
const OLD_FLAGGED_FILTER = {
  paymentMethod: 'wallet',
  status: 'failed',
  'apiResponse.status': 'fail',
  'apiResponse.message': { $exists: false },
  'apiResponse.adminDeducted': { $ne: true },
  adminCleared: { $ne: true },
};
const NEW_FLAGGED_FILTER = {
  paymentMethod: 'wallet',
  status: 'pending',
  'apiResponse._timedOut': true,
  adminCleared: { $ne: true },
};
const POLLER_FAILED_FILTER = {
  paymentMethod: 'wallet',
  status: 'failed',
  'apiResponse._timedOut': true,
  'apiResponse.adminDeducted': { $ne: true },
  adminCleared: { $ne: true },
};
const ODS_DAMAGE_FILTER = {
  paymentMethod: 'wallet',
  status: 'failed',
  'apiResponse.odsDelivered': true,
  'apiResponse.adminDeducted': { $ne: true },
  adminCleared: { $ne: true },
};

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('DB connected\n');
  if (DRY_RUN) console.log('*** DRY RUN — no changes will be written ***\n');

  const [oldFlagged, newFlagged, pollerFailed, odsDamage] = await Promise.all([
    Transaction.find(OLD_FLAGGED_FILTER).populate('user', 'username email').sort({ createdAt: -1 }).lean(),
    Transaction.find(NEW_FLAGGED_FILTER).populate('user', 'username email').sort({ createdAt: -1 }).lean(),
    Transaction.find(POLLER_FAILED_FILTER).populate('user', 'username email').sort({ createdAt: -1 }).lean(),
    Transaction.find(ODS_DAMAGE_FILTER).populate('user', 'username email').sort({ createdAt: -1 }).lean(),
  ]);

  console.log(`=== FLAGGED TRANSACTION AUDIT ===`);
  console.log(`  OLD_FLAGGED  : ${oldFlagged.length}`);
  console.log(`  NEW_FLAGGED  : ${newFlagged.length}`);
  console.log(`  POLLER_FAILED: ${pollerFailed.length}`);
  console.log(`  ODS_DAMAGE   : ${odsDamage.length}`);
  console.log(`  TOTAL        : ${oldFlagged.length + newFlagged.length + pollerFailed.length + odsDamage.length}\n`);

  // ── NEW_FLAGGED, POLLER_FAILED, ODS_DAMAGE — always keep ─────────────────
  if (newFlagged.length) {
    console.log(`KEEP — NEW_FLAGGED (wallet still deducted, needs admin resolution):`);
    newFlagged.forEach(tx => console.log(`  ${new Date(tx.createdAt).toISOString().slice(0,10)} | ${tx.user?.email || tx.user} | ₦${tx.amount} | ${tx._id}`));
    console.log('');
  }
  if (pollerFailed.length) {
    console.log(`KEEP — POLLER_FAILED (timed-out, delivery uncertain):`);
    pollerFailed.forEach(tx => console.log(`  ${new Date(tx.createdAt).toISOString().slice(0,10)} | ${tx.user?.email || tx.user} | ₦${tx.amount} | ${tx._id}`));
    console.log('');
  }
  if (odsDamage.length) {
    console.log(`KEEP — ODS_DAMAGE (confirmed delivery, deduction still needed):`);
    odsDamage.forEach(tx => console.log(`  ${new Date(tx.createdAt).toISOString().slice(0,10)} | ${tx.user?.email || tx.user} | ₦${tx.amount} | ${tx._id}`));
    console.log('');
  }

  // ── OLD_FLAGGED — classify each entry ────────────────────────────────────
  const safeToClear  = [];
  const needsReview  = [];

  for (const tx of oldFlagged) {
    const bBefore = tx.balanceBefore;
    const bAfter  = tx.balanceAfter;

    // POST-FIX clean rejection: both balance fields are set and equal, meaning
    // the wallet was properly refunded. OurDataStore rejected the request outright.
    const isCleanRejection = (
      bBefore != null &&
      bAfter  != null &&
      Math.abs(bBefore - bAfter) < 0.01
    );

    if (isCleanRejection) {
      safeToClear.push(tx);
    } else {
      needsReview.push(tx);
    }
  }

  // ── Report KEEP (needs review) ────────────────────────────────────────────
  if (needsReview.length) {
    console.log(`KEEP — OLD_FLAGGED needs manual review (pre-fix or balance mismatch — may have delivered data):`);
    needsReview.forEach(tx => {
      console.log(
        `  ${new Date(tx.createdAt).toISOString().slice(0,10)}` +
        ` | ${tx.user?.email || tx.user}` +
        ` | ₦${tx.amount}` +
        ` | bal: ${tx.balanceBefore ?? 'null'} → ${tx.balanceAfter ?? 'null'}` +
        ` | ${tx._id}`
      );
    });
    console.log('');
  }

  // ── Report and process SAFE TO CLEAR ─────────────────────────────────────
  console.log(`SAFE TO CLEAR — post-fix clean rejections (wallet was properly refunded, ODS said no):`);
  if (safeToClear.length === 0) {
    console.log('  (none)\n');
  } else {
    safeToClear.forEach(tx => {
      console.log(
        `  ${new Date(tx.createdAt).toISOString().slice(0,10)}` +
        ` | ${tx.user?.email || tx.user}` +
        ` | ₦${tx.amount}` +
        ` | ${tx._id}`
      );
    });
    console.log('');
  }

  if (!DRY_RUN && safeToClear.length > 0) {
    const ids = safeToClear.map(tx => tx._id);
    const result = await Transaction.updateMany(
      { _id: { $in: ids } },
      {
        $set: {
          adminCleared:   true,
          adminClearedAt: new Date(),
          adminClearedBy: 'audit-script',
        },
      }
    );
    console.log(`Cleared ${result.modifiedCount} transactions.\n`);
  } else if (safeToClear.length > 0) {
    console.log(`(dry run — ${safeToClear.length} would be cleared)\n`);
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const keepCount  = newFlagged.length + pollerFailed.length + odsDamage.length + needsReview.length;
  const clearCount = safeToClear.length;
  console.log('=== SUMMARY ===');
  console.log(`  Entries kept (need attention)  : ${keepCount}`);
  console.log(`  Entries cleared (safe noise)    : ${clearCount}`);
  console.log(`  Flagged table now shows         : ${keepCount} entries`);

  await mongoose.disconnect();
}

run().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});
