/**
 * Investigation script: find "invisible" poller-refunded transactions.
 *
 * The transactionPoller.js bug:
 *   1. API times out → transaction saved as status:'pending', apiResponse._timedOut:true
 *   2. After 30 min, poller calls refundAndFail() unconditionally
 *   3. refundAndFail() sets status:'failed' but does NOT touch apiResponse
 *   4. Result: status:'failed' + apiResponse._timedOut:true
 *   5. OLD_FLAGGED_FILTER needs apiResponse.status:'fail' → no match
 *      NEW_FLAGGED_FILTER needs status:'pending' → no match
 *   6. Transaction is invisible on admin dashboard forever
 *
 * This script:
 *   - Finds the specific Aug-6 transaction for comradenwabuezewilliams1@gmail.com
 *   - Finds ALL invisible transactions system-wide
 *   - Reports which ones have already been manually deducted vs still outstanding
 */
require('dotenv').config();
const mongoose    = require('mongoose');
const Transaction = require('../server/models/TransactionModel');
const Wallet      = require('../server/models/WalletModal');
const User        = require('../server/models/UserModel');

const TARGET_EMAIL = 'comradenwabuezewilliams1@gmail.com';

function fmt(n) {
  return typeof n === 'number' ? `₦${n.toLocaleString()}` : n;
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('DB connected\n');

  // ── 1. Find the target user ──────────────────────────────────────────────
  const user = await User.findOne({ email: TARGET_EMAIL }).lean();
  if (!user) {
    console.error(`User not found: ${TARGET_EMAIL}`);
    process.exit(1);
  }
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`TARGET USER: ${user.email}`);
  console.log(`  _id:      ${user._id}`);
  console.log(`  username: ${user.username}`);
  console.log(`  phone:    ${user.phone || user.phoneNumber || '—'}`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  // ── 2. Find all transactions for this user ───────────────────────────────
  const userTxns = await Transaction.find({ user: user._id }).sort({ createdAt: -1 }).lean();
  console.log(`All transactions for user (${userTxns.length} total):`);
  userTxns.forEach((tx, i) => {
    console.log(`  [${i + 1}] _id: ${tx._id}`);
    console.log(`       date:    ${fmtDate(tx.createdAt)}`);
    console.log(`       status:  ${tx.status}`);
    console.log(`       amount:  ${fmt(tx.amount)}`);
    console.log(`       phone:   ${tx.phone}`);
    console.log(`       method:  ${tx.paymentMethod}`);
    console.log(`       apiResponse keys: ${tx.apiResponse ? Object.keys(tx.apiResponse).join(', ') : 'none'}`);
    console.log(`       apiResponse._timedOut:    ${tx.apiResponse?._timedOut}`);
    console.log(`       apiResponse.status:       ${tx.apiResponse?.status}`);
    console.log(`       apiResponse.adminDeducted:${tx.apiResponse?.adminDeducted}`);
    console.log(`       balanceBefore: ${tx.balanceBefore} | balanceAfter: ${tx.balanceAfter}`);
    console.log(`       adminCleared:  ${tx.adminCleared}`);
    console.log();
  });

  // ── 3. Current wallet balance for this user ──────────────────────────────
  const wallet = await Wallet.findOne({ user: user._id }).lean();
  console.log(`Current wallet balance: ${wallet ? fmt(wallet.balances?.NAIRA) : '— (no wallet)'}\n`);

  // ── 4. Find ALL invisible poller-refunded transactions system-wide ────────
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('SYSTEM-WIDE INVISIBLE TRANSACTIONS');
  console.log('  (status:failed + apiResponse._timedOut:true + wallet)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const invisible = await Transaction.find({
    paymentMethod: 'wallet',
    status: 'failed',
    'apiResponse._timedOut': true,
  }).populate('user', 'email username phone').sort({ createdAt: -1 }).lean();

  console.log(`Total invisible transactions found: ${invisible.length}\n`);

  // Segment into:
  //   A) Already admin-deducted (manually handled after user report)
  //   B) Cleared by admin (dismissed)
  //   C) Truly outstanding — data may have been delivered, wallet refunded, no action taken
  const deducted    = invisible.filter(tx => tx.apiResponse?.adminDeducted);
  const cleared     = invisible.filter(tx => tx.adminCleared);
  const outstanding = invisible.filter(tx => !tx.apiResponse?.adminDeducted && !tx.adminCleared);

  console.log(`  Already admin-deducted : ${deducted.length}`);
  console.log(`  Admin-cleared (dismissed): ${cleared.length}`);
  console.log(`  OUTSTANDING (unresolved): ${outstanding.length}\n`);

  if (outstanding.length > 0) {
    console.log('─── OUTSTANDING (unresolved) ───────────────────────────────────');
    let totalOutstanding = 0;
    outstanding.forEach((tx, i) => {
      const u = tx.user;
      totalOutstanding += tx.amount || 0;
      console.log(`  [${i + 1}] _id:    ${tx._id}`);
      console.log(`       date:    ${fmtDate(tx.createdAt)}`);
      console.log(`       user:    ${u?.email || '—'} (${u?.username || '—'})`);
      console.log(`       phone:   ${tx.phone}`);
      console.log(`       amount:  ${fmt(tx.amount)}`);
      console.log(`       requestId: ${tx.apiResponse?.requestId || tx.apiResponse?.request_id || '—'}`);
      console.log(`       apiResponse: ${JSON.stringify(tx.apiResponse)}`);
      console.log();
    });
    console.log(`  Total outstanding amount: ${fmt(totalOutstanding)}\n`);
  }

  if (deducted.length > 0) {
    console.log('─── ALREADY ADMIN-DEDUCTED ─────────────────────────────────────');
    deducted.forEach((tx, i) => {
      const u = tx.user;
      console.log(`  [${i + 1}] _id: ${tx._id} | ${fmtDate(tx.createdAt)} | ${fmt(tx.amount)} | ${u?.email || '—'} | phone: ${tx.phone}`);
      console.log(`       deductedAt: ${tx.apiResponse?.adminDeductedAt || '—'}`);
    });
    console.log();
  }

  // ── 5. Also look for transactions stuck in pending with _timedOut:true ───
  //       (these are caught by NEW_FLAGGED_FILTER, but let's see how many there are)
  const pendingTimedOut = await Transaction.countDocuments({
    paymentMethod: 'wallet',
    status: 'pending',
    'apiResponse._timedOut': true,
  });
  console.log(`─── Still pending+_timedOut (visible on flagged page): ${pendingTimedOut} ───\n`);

  // ── 6. Look for any other anomalous 'failed' wallet transactions ─────────
  //       that have neither apiResponse.status:'fail' nor _timedOut:true
  //       (might indicate other invisible patterns)
  const otherFailed = await Transaction.countDocuments({
    paymentMethod: 'wallet',
    status: 'failed',
    'apiResponse.status': { $ne: 'fail' },
    'apiResponse._timedOut': { $ne: true },
    'apiResponse.adminDeducted': { $ne: true },
    adminCleared: { $ne: true },
  });
  console.log(`─── Other failed wallet txns not matching any filter: ${otherFailed} ───`);
  if (otherFailed > 0) {
    const others = await Transaction.find({
      paymentMethod: 'wallet',
      status: 'failed',
      'apiResponse.status': { $ne: 'fail' },
      'apiResponse._timedOut': { $ne: true },
      'apiResponse.adminDeducted': { $ne: true },
      adminCleared: { $ne: true },
    }).populate('user', 'email').sort({ createdAt: -1 }).limit(20).lean();
    others.forEach((tx, i) => {
      console.log(`  [${i + 1}] ${tx._id} | ${fmtDate(tx.createdAt)} | ${fmt(tx.amount)} | ${tx.user?.email || '—'}`);
      console.log(`       apiResponse: ${JSON.stringify(tx.apiResponse)}`);
    });
  }

  console.log('\nDone.');
  process.exit(0);
}

run().catch(err => { console.error(err); process.exit(1); });
