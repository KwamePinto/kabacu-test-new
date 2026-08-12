'use strict';

require('dotenv').config();
const mongoose  = require('mongoose');
const User        = require('../server/models/UserModel');
const Wallet      = require('../server/models/WalletModal');
const Transaction = require('../server/models/TransactionModel');
require('../server/models/ProductsModal'); // register Product schema for populate

const TARGET_EMAIL = 'samgovic@gmail.com';

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('DB connected\n');

  const user = await User.findOne({ email: TARGET_EMAIL }).lean();
  if (!user) { console.error('User not found'); process.exit(1); }

  console.log('=== USER ===');
  console.log('Username  :', user.username);
  console.log('Email     :', user.email);
  console.log('Phone     :', user.phone_number);
  console.log('Verified  :', user.isVerified);
  console.log('Joined    :', new Date(user.createdAt).toLocaleString('en-GB'));
  console.log('');

  const wallet = await Wallet.findOne({ user: user._id }).lean();
  if (wallet) {
    console.log('=== WALLET ===');
    console.log('NAIRA     :', wallet.balances.NAIRA);
    console.log('RP        :', wallet.balances.RP);
    console.log('');
  }

  const txns = await Transaction.find({ user: user._id })
    .populate('product', 'item_name dataDetails')
    .sort({ createdAt: 1 })
    .lean();

  console.log('=== ALL TRANSACTIONS (' + txns.length + ' total) ===\n');

  txns.forEach(function(tx, i) {
    var ts   = new Date(tx.createdAt).toLocaleString('en-GB');
    var prod = tx.product ? tx.product.item_name : '(no product)';
    var api  = tx.apiResponse || {};

    console.log('[' + (i + 1) + '] ' + ts);
    console.log('    Ref         :', tx.reference);
    console.log('    Status      :', tx.status);
    console.log('    Amount      : ₦' + (tx.amount || 0).toLocaleString());
    console.log('    Phone       :', tx.phone);
    console.log('    Product     :', prod);
    console.log('    PayMethod   :', tx.paymentMethod);
    console.log('    WalletType  :', tx.walletType);
    console.log('    Bal Before  :', tx.balanceBefore != null ? '₦' + tx.balanceBefore : '—');
    console.log('    Bal After   :', tx.balanceAfter  != null ? '₦' + tx.balanceAfter  : '—');

    // Key apiResponse flags
    if (api._timedOut)       console.log('    _timedOut   : YES');
    if (api.odsDelivered)    console.log('    odsDelivered: YES');
    if (api.adminDeducted)   console.log('    adminDeducted: YES (by ' + (api.adminDeductedBy || 'unknown') + ')');
    if (api.adminRefunded)   console.log('    adminRefunded: YES');
    if (api.status)          console.log('    api.status  :', api.status);
    if (api.message)         console.log('    api.message :', api.message);
    if (api.orderNo)         console.log('    orderNo     :', api.orderNo);
    if (api.requestId)       console.log('    requestId   :', api.requestId);

    // Full apiResponse for failed/flagged txns
    if (tx.status === 'failed' || tx.status === 'pending') {
      console.log('    apiResponse :', JSON.stringify(api, null, 6).split('\n').join('\n    '));
    }

    console.log('');
  });

  // Summary by status
  const byStatus = {};
  txns.forEach(function(t) { byStatus[t.status] = (byStatus[t.status] || 0) + 1; });
  console.log('=== STATUS SUMMARY ===');
  Object.entries(byStatus).forEach(function([s, n]) { console.log('  ' + s + ': ' + n); });
  console.log('');

  // Flag the ones that are in the flagged-transactions criteria
  const flagged = txns.filter(function(t) {
    var api = t.apiResponse || {};
    var isOld = t.paymentMethod === 'wallet' && t.status === 'failed' && api.status === 'fail' && !api.message && !api.adminDeducted && !t.adminCleared;
    var isNew = t.paymentMethod === 'wallet' && t.status === 'pending' && api._timedOut && !t.adminCleared;
    var isPoller = t.paymentMethod === 'wallet' && t.status === 'failed' && api._timedOut && !api.adminDeducted && !t.adminCleared;
    var isOds = t.paymentMethod === 'wallet' && t.status === 'failed' && api.odsDelivered && !api.adminDeducted && !t.adminCleared;
    return isOld || isNew || isPoller || isOds;
  });

  console.log('=== FLAGGED TRANSACTIONS (' + flagged.length + ') ===');
  flagged.forEach(function(tx) {
    var api = tx.apiResponse || {};
    console.log('  ' + new Date(tx.createdAt).toLocaleString('en-GB') +
      ' | ₦' + (tx.amount||0) + ' | ' + tx.phone +
      ' | status=' + tx.status +
      (api._timedOut ? ' | timedOut' : '') +
      (api.odsDelivered ? ' | odsDelivered' : '') +
      (api.status ? ' | api.status=' + api.status : ''));
  });

  console.log('\nTotal amount at risk: ₦' + flagged.reduce((s,t) => s + (t.amount||0), 0).toLocaleString());

  await mongoose.disconnect();
}

run().catch(function(err) {
  console.error('Script failed:', err);
  process.exit(1);
});
