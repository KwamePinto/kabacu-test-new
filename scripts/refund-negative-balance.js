'use strict';

/**
 * Refund the negative NAIRA wallet balance for a specific user back to zero.
 * Usage: node scripts/refund-negative-balance.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const User      = require('../server/models/UserModel');
const Wallet    = require('../server/models/WalletModal');
const Transaction = require('../server/models/TransactionModel');

const TARGET_EMAIL = 'ogundepovictoria7@gmail.com';

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('DB connected\n');

  // 1. Find user
  const user = await User.findOne({ email: TARGET_EMAIL }).lean();
  if (!user) {
    console.error(`No user found with email: ${TARGET_EMAIL}`);
    process.exit(1);
  }
  console.log(`User found: ${user.username} (${user._id})`);

  // 2. Find wallet
  const wallet = await Wallet.findOne({ user: user._id });
  if (!wallet) {
    console.error('No wallet found for this user.');
    process.exit(1);
  }

  const currentBalance = wallet.balances.NAIRA;
  console.log(`Current NAIRA balance: ${currentBalance}`);

  if (currentBalance >= 0) {
    console.log('Balance is already zero or positive — no refund needed.');
    process.exit(0);
  }

  // 3. Amount to credit = absolute value of negative balance
  const refundAmount = Math.abs(currentBalance);
  console.log(`Refund amount: ${refundAmount} (will bring balance to 0)\n`);

  // 4. Credit the wallet
  wallet.balances.NAIRA = 0;
  await wallet.save();
  console.log('Wallet updated: NAIRA balance is now 0');

  // 5. Create an audit transaction record
  const reference = 'ADMIN-REFUND-NEG-' + Date.now();
  await Transaction.create({
    user:          user._id,
    amount:        refundAmount,
    walletType:    'NAIRA',
    paymentMethod: 'Admin',
    status:        'refunded',
    reference,
    balanceBefore: currentBalance,
    balanceAfter:  0,
    apiResponse: {
      adminRefunded:    true,
      adminRefundedAt:  new Date(),
      refundApprovedBy: 'System Script',
      refundReason:     'Administrative refund to restore wallet to zero after accidental negative balance from admin deduction.',
    },
  });
  console.log(`Audit transaction created: ${reference}`);

  console.log('\nDone. Wallet balance restored to 0.');
  await mongoose.disconnect();
}

run().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});
