'use strict';
/**
 * Backfill: set rpEarned = 0 on all failed and pending transactions
 * where rpEarned is incorrectly > 0.
 * No RP was ever actually credited on these — this is purely a display fix.
 */

require('dotenv').config();
const mongoose    = require('mongoose');
const Transaction = require('../server/models/TransactionModel');

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('DB connected\n');

  const count = await Transaction.countDocuments({
    status:   { $in: ['failed', 'pending'] },
    rpEarned: { $gt: 0 },
  });
  console.log(`Found ${count} failed/pending transactions with rpEarned > 0`);

  if (count === 0) {
    console.log('Nothing to update.');
    await mongoose.disconnect();
    return;
  }

  const result = await Transaction.updateMany(
    { status: { $in: ['failed', 'pending'] }, rpEarned: { $gt: 0 } },
    { $set: { rpEarned: 0 } }
  );

  console.log(`Updated ${result.modifiedCount} transactions — rpEarned set to 0.`);
  await mongoose.disconnect();
}

run().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});
