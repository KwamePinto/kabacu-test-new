/**
 * Deep diagnostic — checks why purchases for 07073181749 aren't reaching OurDataStore.
 * Run: node scripts/diagnose-07073181749-deep.js
 */
require('dotenv').config();
const mongoose = require('mongoose');

const PHONE = '07073181749';
const PHONE_VARIANTS = ['07073181749', '+2347073181749', '2347073181749', '7073181749'];
const DAYS_BACK = 14;
const SINCE = new Date(Date.now() - DAYS_BACK * 24 * 60 * 60 * 1000);

const Checkout    = require('../server/models/CheckoutModal');
const Transaction = require('../server/models/TransactionModel');
const Product     = require('../server/models/ProductsModal');
const Wallet      = require('../server/models/WalletModal');

// Lazy-load User model to avoid collision if already registered
function getUserModel() {
  try { return mongoose.model('user'); } catch (_) {}
  return mongoose.model('user', new mongoose.Schema({
    firstname: String, lastname: String, username: String,
    email: String, phone_number: String, phone: String,
    isVerified: Boolean, minerId: String,
  }, { strict: false }));
}

function hr(title = '') {
  const line = '═'.repeat(60);
  console.log('\n' + line);
  if (title) { console.log('  ' + title); console.log(line); }
}

function indent(str, n = 4) {
  return String(str).split('\n').map(l => ' '.repeat(n) + l).join('\n');
}

async function run() {
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  console.log('✓ MongoDB connected\n');

  const User = getUserModel();

  // ── 1. Find the user who owns this phone ─────────────────────────────
  hr('1 · USER ACCOUNT FOR ' + PHONE);

  const users = await User.find({
    $or: PHONE_VARIANTS.flatMap(v => [{ phone_number: v }, { phone: v }]),
  }).lean();

  if (!users.length) {
    console.log(indent('⚠  No user found with this phone number.'));
  }

  const userIds = users.map(u => u._id);

  for (const u of users) {
    console.log(indent(`Name:     ${u.firstname || u.username || '—'} ${u.lastname || ''}`));
    console.log(indent(`Email:    ${u.email}`));
    console.log(indent(`_id:      ${u._id}`));
    console.log(indent(`phone:    ${u.phone_number || u.phone}`));
    console.log(indent(`verified: ${u.isVerified}`));

    const wallet = await Wallet.findOne({ user: u._id }).lean();
    if (wallet) {
      const b = wallet.balances || {};
      console.log(indent(`Wallet balances:`));
      Object.entries(b).forEach(([k, v]) =>
        console.log(indent(`  ${k.padEnd(6)}: ${v}${k === 'NAIRA' ? ' ← current spendable balance' : ''}`, 6))
      );
    } else {
      console.log(indent(`Wallet: NOT FOUND`));
    }
  }

  // ── 2. All transactions (all statuses) for this user in last 30 days ─
  hr(`2 · ALL TRANSACTIONS (last 30 days) — balance trail`);

  const SINCE30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const allTxs = await Transaction.find({
    $or: [
      { phone: { $in: PHONE_VARIANTS } },
      ...(userIds.length ? [{ user: { $in: userIds } }] : []),
    ],
    createdAt: { $gte: SINCE30 },
  })
    .sort({ createdAt: -1 })
    .limit(30)
    .populate('product', 'dataDetails productName')
    .lean();

  if (!allTxs.length) {
    console.log(indent('No transactions in the last 30 days.'));
  } else {
    console.log(indent(`${allTxs.length} transaction(s) — latest first:\n`));
    for (const tx of allTxs) {
      const d = tx.product?.dataDetails || {};
      const bal = tx.balanceAfter != null
        ? `  wallet: ₦${tx.balanceBefore ?? '?'} → ₦${tx.balanceAfter}`
        : '';
      console.log(indent(`[${tx.status.toUpperCase()}] ${new Date(tx.createdAt).toLocaleString('en-NG')} | ₦${tx.amount} | ${d.plan_name || tx.product?.productName || 'N/A'}${bal}`));
    }
  }

  // ── 3. Recent checkouts (last 14 days) ───────────────────────────────
  hr(`3 · RECENT CHECKOUTS (last ${DAYS_BACK} days)`);

  const phoneFilter = PHONE_VARIANTS.map(v => ({ phone: v }));
  const userFilter  = userIds.map(id => ({ user: id }));

  const checkouts = await Checkout.find({
    createdAt: { $gte: SINCE },
    $or: [...phoneFilter, ...userFilter],
  })
    .sort({ createdAt: -1 })
    .limit(30)
    .populate('product', 'dataDetails productName productPrice isActive is_deleted')
    .lean();

  if (!checkouts.length) {
    console.log(indent(`No checkouts in the last ${DAYS_BACK} days.`));
  } else {
    console.log(indent(`Found ${checkouts.length} checkout(s):\n`));
    for (const c of checkouts) {
      const p = c.product;
      const d = p?.dataDetails || {};
      const activeStr = p
        ? (p.isActive !== false && !p.is_deleted ? '✓ active' : '✗ INACTIVE/DELETED')
        : '⚠ product not found';
      console.log(indent(`[${c.status.toUpperCase()}] ${new Date(c.createdAt).toLocaleString('en-NG')}`));
      console.log(indent(`  phone:   ${c.phone}`));
      console.log(indent(`  product: ${d.plan_name || p?.productName || 'N/A'} (${activeStr})`));
      console.log(indent(`  amount:  ₦${d.amount ?? p?.productPrice ?? 'N/A'}  |  plan_id: ${d.plan_id ?? 'N/A'}`));
      console.log();
    }
  }

  // ── 4. Active vs inactive MTN products ───────────────────────────────
  hr('4 · MTN PRODUCTS STATUS');

  const allMtn = await Product.find({
    category: 'DATA',
    'dataDetails.network': { $regex: /MTN/i },
  }).lean();

  const active   = allMtn.filter(p => p.isActive !== false && !p.is_deleted);
  const inactive = allMtn.filter(p => p.isActive === false || p.is_deleted);
  console.log(indent(`Active: ${active.length}  |  Inactive/deleted: ${inactive.length}`));

  if (inactive.length) {
    console.log(indent('\nInactive MTN products:'));
    for (const p of inactive) {
      const d = p.dataDetails || {};
      console.log(indent(`  plan_id=${d.plan_id} | ${d.plan_name || p.productName} | ₦${d.amount}`));
    }
  }

  console.log(indent('\nActive MTN products (cheapest first):'));
  active.sort((a, b) => (a.dataDetails?.amount || 0) - (b.dataDetails?.amount || 0));
  for (const p of active) {
    const d = p.dataDetails || {};
    console.log(indent(`  ₦${String(d.amount).padEnd(7)} | plan_id=${d.plan_id} | ${d.plan_name || p.productName}`));
  }

  await mongoose.disconnect();
  hr();
  console.log('Done.');
}

run().catch(err => {
  console.error('\n✗ Script error:', err.message, err.stack);
  process.exit(1);
});
