/**
 * Diagnostic script for phone 07073181749
 *
 * Run from project root:
 *   node scripts/diagnose-07073181749.js
 *   node scripts/diagnose-07073181749.js --create-test   ← also creates a test product
 */
require('dotenv').config();
const mongoose = require('mongoose');
const axios    = require('axios');

const PHONE = '07073181749';
const PHONE_VARIANTS = ['07073181749', '+2347073181749', '2347073181749', '7073181749'];
const CREATE_TEST = process.argv.includes('--create-test');

// ── Models ────────────────────────────────────────────────────────────────────
const Transaction = require('../server/models/TransactionModel');
const Product     = require('../server/models/ProductsModal');

// ── Helpers ───────────────────────────────────────────────────────────────────
function hr(title = '') {
  const line = '═'.repeat(60);
  console.log('\n' + line);
  if (title) console.log('  ' + title);
  if (title) console.log(line);
}

function indent(str, n = 4) {
  return String(str).split('\n').map(l => ' '.repeat(n) + l).join('\n');
}

// ── OurDataStore token helper (self-contained, no cached state from app) ──────
async function getOdsToken() {
  const user = process.env.OURDATASTORE_USERNAME;
  const pass = process.env.OURDATASTORE_PASSWORD;
  if (!user || !pass) throw new Error('OURDATASTORE_USERNAME / PASSWORD not set in .env');
  const auth = Buffer.from(`${user}:${pass}`).toString('base64');
  const r = await axios.post('https://ourdatastore.com/api/user', {}, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (r.data.status !== 'success') throw new Error('ODS auth failed: ' + r.data.message);
  return r.data.AccessToken;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  console.log('✓ MongoDB connected');

  // ── 1. All DB transactions for the number ────────────────────────────────
  hr('1 · DB TRANSACTIONS FOR ' + PHONE);

  const txs = await Transaction.find({ phone: { $in: PHONE_VARIANTS } })
    .sort({ createdAt: -1 })
    .limit(30)
    .populate('product', 'dataDetails productName productPrice')
    .lean();

  if (!txs.length) {
    console.log(indent('⚠  No transactions found for any phone variant:'));
    PHONE_VARIANTS.forEach(v => console.log(indent('   ' + v)));
  } else {
    console.log(indent(`Found ${txs.length} transaction(s) — most recent first:\n`));
    for (const tx of txs) {
      const d = tx.product?.dataDetails || {};
      console.log(indent(`[${tx.status.toUpperCase()}] ${new Date(tx.createdAt).toLocaleString('en-NG')}`));
      console.log(indent(`  ref:      ${tx.reference}`));
      console.log(indent(`  amount:   ₦${tx.amount}`));
      console.log(indent(`  product:  ${d.plan_name || tx.product?.productName || 'N/A'}`));
      console.log(indent(`  network:  ${d.network || 'N/A'}  |  plan_id: ${d.plan_id ?? 'N/A'}`));
      console.log(indent(`  apiResponse:`));
      console.log(indent(JSON.stringify(tx.apiResponse, null, 2), 6));
      console.log();
    }
  }

  // ── 2. OurDataStore history search for the number ────────────────────────
  hr('2 · OURDATASTORE HISTORY SEARCH');

  try {
    const { fetchDataTransactions } = require('../server/services/ourdatastore');
    const result = await fetchDataTransactions({ page: 1, status: 'ALL', search: PHONE, perPage: 50 });
    const rows   = result.data || [];

    if (!rows.length) {
      console.log(indent('No records found on OurDataStore for ' + PHONE));
    } else {
      console.log(indent(`Found ${rows.length} OurDataStore record(s):\n`));
      for (const r of rows) {
        const s = r.plan_status === 1 ? '✓ SUCCESS' : r.plan_status === 2 ? '✗ FAIL' : '⋯ PROCESSING';
        console.log(indent(`[${s}] ${r.plan_date} | ₦${r.amount} | phone=${r.plan_phone} | transid=${r.transid}`));
      }
    }
  } catch (err) {
    console.log(indent('OurDataStore lookup failed: ' + err.message));
  }

  // ── 3. All active MTN products in DB ─────────────────────────────────────
  hr('3 · ACTIVE MTN PRODUCTS IN DB (cheapest first)');

  const mtnProducts = await Product.find({
    category: 'DATA',
    'dataDetails.network': { $regex: /MTN/i },
    is_deleted: { $ne: 1 },
    isActive: true,
  })
    .sort({ 'dataDetails.amount': 1 })
    .lean();

  if (!mtnProducts.length) {
    console.log(indent('No active MTN products found.'));
  } else {
    console.log(indent(`${mtnProducts.length} products:\n`));
    for (const p of mtnProducts) {
      const d = p.dataDetails || {};
      console.log(indent(
        `plan_id=${String(d.plan_id).padEnd(6)} | ₦${String(d.amount).padEnd(7)} | ${String(d.plan_name || p.productName).padEnd(30)} | ${d.plan_type || ''} | ${d.validate_period || ''}`
      ));
    }
  }

  // ── 4. OurDataStore available data plans (network=1, MTN) ────────────────
  hr('4 · OURDATASTORE AVAILABLE MTN PLANS');

  try {
    const token = await getOdsToken();
    // Standard OurDataStore endpoint to list plans
    const r = await axios.get('https://ourdatastore.com/api/data', {
      params:  { network: 1 },
      headers: { Authorization: `Token ${token}` },
    });
    const plans = Array.isArray(r.data) ? r.data
                : Array.isArray(r.data?.data) ? r.data.data
                : [];

    if (!plans.length) {
      console.log(indent('No plans returned (response below):'));
      console.log(indent(JSON.stringify(r.data, null, 2), 6));
    } else {
      console.log(indent(`${plans.length} MTN plans available on OurDataStore:\n`));
      for (const p of plans) {
        console.log(indent(
          `plan_id=${String(p.id ?? p.plan_id ?? '?').padEnd(6)} | ${String(p.plan ?? p.name ?? p.plan_name ?? '').padEnd(30)} | ₦${p.price ?? p.amount ?? '?'} | ${p.month_validate ?? p.validity ?? ''}`
        ));
      }
    }
  } catch (err) {
    console.log(indent('Could not fetch ODS plans: ' + (err.response?.data ? JSON.stringify(err.response.data) : err.message)));
  }

  // ── 5. Create test product (if --create-test flag given) ──────────────────
  if (CREATE_TEST) {
    hr('5 · CREATING TEST PRODUCT');

    // Use the cheapest existing MTN product's plan_id so we know it's valid
    if (!mtnProducts.length) {
      console.log(indent('✗ Cannot create test product — no MTN products in DB to borrow plan_id from.'));
    } else {
      const cheapest = mtnProducts[0];
      const d = cheapest.dataDetails;

      const existing = await Product.findOne({ 'dataDetails.plan_name': 'DIAG-TEST-MTN' }).lean();
      if (existing) {
        console.log(indent(`Test product already exists: _id=${existing._id}`));
        console.log(indent(`plan_id=${existing.dataDetails.plan_id} | ₦${existing.dataDetails.amount} | ${existing.dataDetails.plan_name}`));
      } else {
        const testProduct = await Product.create({
          category:    'DATA',
          description: 'Diagnostic test product — one-time use',
          isActive:    true,
          is_deleted:  0,
          costPrice:   d.amount,
          reward_point: 0,
          productName: 'DIAG-TEST-MTN',
          dataDetails: {
            plan_id:         d.plan_id,
            network:         'MTN',
            plan_type:       d.plan_type,
            plan_name:       'DIAG-TEST-MTN',
            amount:          d.amount,
            oldPrice:        d.amount,
            validate_period: d.validate_period,
          },
        });
        console.log(indent(`✓ Test product created:`));
        console.log(indent(`  _id:      ${testProduct._id}`));
        console.log(indent(`  plan_id:  ${testProduct.dataDetails.plan_id}  (same as "${d.plan_name}")`));
        console.log(indent(`  amount:   ₦${testProduct.dataDetails.amount}`));
        console.log(indent(`  network:  MTN`));
        console.log(indent(`\nTo delete after testing:`));
        console.log(indent(`  db.products.deleteOne({ _id: ObjectId("${testProduct._id}") })`));
      }
    }
  }

  await mongoose.disconnect();
  hr();
  console.log('Done.');
}

run().catch(err => {
  console.error('\n✗ Script error:', err.message);
  process.exit(1);
});
