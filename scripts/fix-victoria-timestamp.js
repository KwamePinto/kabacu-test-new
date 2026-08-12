'use strict';
/**
 * Fix the refund transaction for ogundepovictoria7@gmail.com.
 * It was created just after midnight UTC (00:32 UTC = 01:32 WAT Aug 12)
 * so it shows as Aug 12 in the admin UI. Correct it back to Aug 11.
 */

require('dotenv').config();
const mongoose    = require('mongoose');
const Transaction = require('../server/models/TransactionModel');

const REF = 'ADMIN-REFUND-NEG-1786494740536';
const CORRECT_DATE = new Date('2026-08-11T22:00:00.000Z'); // 11 PM UTC = 11 Aug in all timezones

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('DB connected\n');

  const tx = await Transaction.findOne({ reference: REF });
  if (!tx) {
    console.error('Transaction not found:', REF);
    process.exit(1);
  }

  console.log('Found:', REF);
  console.log('Current createdAt  :', tx.createdAt.toISOString());
  console.log('Current adminRefundedAt:', tx.apiResponse?.adminRefundedAt);

  // Update createdAt (requires bypassing Mongoose timestamps)
  await Transaction.collection.updateOne(
    { _id: tx._id },
    {
      $set: {
        createdAt: CORRECT_DATE,
        updatedAt: CORRECT_DATE,
        'apiResponse.adminRefundedAt': CORRECT_DATE,
      },
    }
  );

  console.log('\nUpdated to:', CORRECT_DATE.toISOString());
  console.log('Done.');

  await mongoose.disconnect();
}

run().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});
