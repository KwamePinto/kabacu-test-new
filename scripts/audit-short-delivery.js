/**
 * Finds transactions where OurDataStore reported overall success but only
 * delivered part of the bundle.
 *
 *   node scripts/audit-short-delivery.js              # print the table
 *   node scripts/audit-short-delivery.js --json out.json
 *
 * ── How short delivery is detectable ────────────────────────────────────────
 * Large bundles are split into legs (5GB each). If a leg fails, OurDataStore
 * still reports plan_status = 1 and our stored message still claims the full
 * amount was shared — so nothing on our side reveals it.
 *
 * The only signal is the ODS row's `api_response` field:
 *     "Hello Chief! 1 Failed 2 Successful and 0 Unsure out of the transactions"
 *
 * ODS `transid` equals our `apiResponse.requestId`, so the two sides join on a
 * key rather than on a fuzzy phone + time window.
 *
 * Delivered volume is assumed proportional to successful legs, which matches
 * the observed 5GB granularity (15GB = 3 legs; 2 successful = 10GB).
 */
require('dotenv').config();
const mongoose = require('mongoose');

const Transaction = require('../server/models/TransactionModel');
const Product     = require('../server/models/ProductsModal');
// Registers the 'user' schema so .populate('user') resolves
require('../server/models/UserModel');

const PER_PAGE   = 100;
const MAX_PAGES  = 80;    // 4,745 rows at the time of writing
const PAGE_GAP_MS = 300;  // be gentle on their API

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** "1 Failed 2 Successful and 0 Unsure" -> { failed, ok, unsure, legs } */
function parseLegs(apiResponse) {
  const m = String(apiResponse || '').match(/(\d+)\s*Failed\s+(\d+)\s*Successful\s+and\s+(\d+)\s*Unsure/i);
  if (!m) return null;
  const failed = +m[1], ok = +m[2], unsure = +m[3];
  return { failed, ok, unsure, legs: failed + ok + unsure };
}

/** "15GB Data Plan" / "15GB" -> 15 */
function gbOf(text) {
  const m = String(text || '').match(/([\d.]+)\s*GB/i);
  return m ? parseFloat(m[1]) : null;
}

(async () => {
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 30000 });
  const { fetchDataTransactions } = require('../server/services/ourdatastore');

  // ── 1. Pull every ODS row, keyed by transid ──────────────────────────────
  const odsByTransid = new Map();
  let page = 1, pages = null;
  while (page <= MAX_PAGES) {
    const r = await fetchDataTransactions({ page, status: 'ALL', perPage: PER_PAGE });
    const rows = r.data || [];
    if (pages === null) {
      pages = r.last_page || 1;
      process.stderr.write(`ODS: ${r.total} rows across ${pages} pages\n`);
    }
    rows.forEach(x => { if (x.transid) odsByTransid.set(String(x.transid), x); });
    process.stderr.write(`\r  fetched page ${page}/${Math.min(pages, MAX_PAGES)}  (${odsByTransid.size} rows)`);
    if (!rows.length || page >= pages) break;
    page++;
    await sleep(PAGE_GAP_MS);
  }
  process.stderr.write('\n\n');

  // ── 2. Join to our successful transactions ───────────────────────────────
  const products = await Product.find({ category: 'DATA' }).lean();
  const byId = new Map(products.map(p => [String(p._id), p]));

  const ours = await Transaction.find({ status: 'success' })
    .select('reference phone amount createdAt apiResponse product products user')
    .populate('user', 'username email')
    .lean();

  const short = [];
  let joined = 0, noRequestId = 0, notInOds = 0, noLegInfo = 0, fullyOk = 0;

  for (const tx of ours) {
    const rid = (tx.apiResponse || {}).requestId;
    if (!rid) { noRequestId++; continue; }

    const row = odsByTransid.get(String(rid));
    if (!row) { notInOds++; continue; }
    joined++;

    const legs = parseLegs(row.api_response);
    if (!legs) { noLegInfo++; continue; }          // single-leg purchase
    if (legs.failed === 0) { fullyOk++; continue; } // split but all legs landed

    // Bundle size: prefer the product, fall back to the ODS plan_name
    const prod = tx.product ? byId.get(String(tx.product)) : null;
    const boughtGb = gbOf(prod && prod.dataDetails && prod.dataDetails.plan_type) || gbOf(row.plan_name);
    const perLeg = boughtGb && legs.legs ? boughtGb / legs.legs : null;
    const deliveredGb = perLeg != null ? perLeg * legs.ok : null;
    const missingGb   = boughtGb != null && deliveredGb != null ? boughtGb - deliveredGb : null;

    // Naira value of what was not delivered, as a share of what the user paid
    const lostValue = boughtGb && missingGb != null
      ? Math.round((tx.amount / boughtGb) * missingGb)
      : null;

    short.push({
      date: tx.createdAt,
      reference: tx.reference,
      transid: rid,
      phone: tx.phone,
      user: tx.user ? tx.user.username : '',
      email: tx.user ? tx.user.email : '',
      amountPaid: tx.amount,
      boughtGb, deliveredGb, missingGb,
      legs: legs.legs, legsOk: legs.ok, legsFailed: legs.failed, legsUnsure: legs.unsure,
      lostValue,
      planType: (prod && prod.dataDetails && prod.dataDetails.plan_type) || row.plan_name || '',
      network: (prod && prod.dataDetails && prod.dataDetails.network) || row.network || '',
    });
  }

  short.sort((a, b) => new Date(b.date) - new Date(a.date));

  console.log('MATCHING');
  console.log(`  our successful transactions      ${ours.length}`);
  console.log(`  with an ODS requestId            ${joined + notInOds}`);
  console.log(`  joined to an ODS row             ${joined}`);
  console.log(`  no requestId stored              ${noRequestId}`);
  console.log(`  requestId not found on ODS       ${notInOds}`);
  console.log(`  single-leg (no split reported)   ${noLegInfo}`);
  console.log(`  split, all legs delivered        ${fullyOk}`);
  console.log(`  SHORT-DELIVERED                  ${short.length}`);

  const totalLost = short.reduce((s, r) => s + (r.lostValue || 0), 0);
  const totalPaid = short.reduce((s, r) => s + (r.amountPaid || 0), 0);
  const totalMissingGb = short.reduce((s, r) => s + (r.missingGb || 0), 0);

  console.log('\nCOST');
  console.log(`  customers affected               ${new Set(short.map(r => r.email)).size}`);
  console.log(`  total paid on affected orders    ₦${totalPaid.toLocaleString()}`);
  console.log(`  data not delivered               ${totalMissingGb}GB`);
  console.log(`  value not delivered              ₦${totalLost.toLocaleString()}`);

  if (short.length) {
    console.log('\nSHORT-DELIVERED TRANSACTIONS');
    console.log('  date              reference                        bought  delivered  legs   lost');
    short.forEach(r => console.log(
      `  ${new Date(r.date).toISOString().slice(0, 16).replace('T', ' ')}  ${String(r.reference).padEnd(30)} ` +
      `${String(r.boughtGb + 'GB').padStart(6)}  ${String(r.deliveredGb + 'GB').padStart(9)}  ${r.legsOk}/${r.legs}   ₦${String(r.lostValue).padStart(5)}`
    ));
  }

  const jsonIdx = process.argv.indexOf('--json');
  if (jsonIdx !== -1 && process.argv[jsonIdx + 1]) {
    require('fs').writeFileSync(process.argv[jsonIdx + 1], JSON.stringify({ short, totalLost, totalMissingGb }, null, 2));
    console.log(`\nwritten to ${process.argv[jsonIdx + 1]}`);
  }

  await mongoose.disconnect();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
