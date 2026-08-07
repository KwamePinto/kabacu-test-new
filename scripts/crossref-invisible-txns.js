/**
 * Cross-reference the 120 invisible poller-refunded transactions against OurDataStore.
 *
 * Strategy (efficient):
 *   1. Download ALL OurDataStore data transactions from the last 7 days in one pass
 *   2. Match each of our 120 DB transactions against the ODS records locally
 *   3. Categorise: DELIVERED | FAILED | NOT FOUND
 *
 * OurDataStore is Nigeria time (UTC+1); our DB is UTC+0 (Ghana).
 * Time matching window: ±2 hours.
 *
 * Run: node scripts/crossref-invisible-txns.js
 */
require('dotenv').config();
const mongoose    = require('mongoose');
const fs          = require('fs');
const path        = require('path');
const Transaction = require('../server/models/TransactionModel');
require('../server/models/UserModel'); // register User schema for populate
const { fetchDataTransactions } = require('../server/services/ourdatastore');

const sleep = ms => new Promise(r => setTimeout(r, ms));

const POLLER_FAILED_FILTER = {
  paymentMethod: 'wallet',
  status: 'failed',
  'apiResponse._timedOut': true,
  'apiResponse.adminDeducted': { $ne: true },
  adminCleared: { $ne: true },
};

const ODS_OFFSET_MS = 60 * 60 * 1000;   // ODS is UTC+1, we are UTC+0
const WINDOW_MS     = 2  * 60 * 60 * 1000; // ±2h match window

function normalisePhone(p) {
  return String(p || '').replace(/\D/g, '').replace(/^234/, '0');
}

function fmtDate(d) {
  return new Date(d).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

async function downloadOdsTransactions() {
  // Download all ODS transactions starting from most recent, stopping when
  // we reach records older than 8 days (our range is Aug 3-7, max 7 days ago).
  const cutoff = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  const all    = [];
  let page     = 1;

  console.log('Downloading OurDataStore transactions...');
  while (true) {
    let result;
    try {
      result = await fetchDataTransactions({ page, status: 'ALL', search: '', perPage: 100 });
    } catch (e) {
      console.error(`  ODS fetch error on page ${page}: ${e.message}`);
      break;
    }

    const rows = result.data || [];
    if (!rows.length) break;

    all.push(...rows);
    process.stdout.write(`\r  Downloaded: ${all.length} transactions (page ${page})`);

    // Check if the oldest row on this page is past our cutoff
    const oldest = rows[rows.length - 1];
    if (oldest?.plan_date) {
      const oldestUtc = new Date(new Date(oldest.plan_date).getTime() - ODS_OFFSET_MS);
      if (oldestUtc < cutoff) break;
    }

    page++;
    await sleep(800); // gentle rate-limit between page fetches
  }

  console.log(`\n  Total ODS records downloaded: ${all.length}\n`);
  return all;
}

function findOdsMatch(tx, odsRows) {
  const txPhone  = normalisePhone(tx.phone);
  const txDateMs = new Date(tx.createdAt).getTime();

  const candidates = odsRows.filter(row => {
    if (normalisePhone(row.plan_phone) !== txPhone) return false;
    const odsMs = new Date(row.plan_date).getTime() - ODS_OFFSET_MS; // convert ODS UTC+1 → UTC
    return Math.abs(odsMs - txDateMs) <= WINDOW_MS;
  });

  if (!candidates.length) return null;

  // If multiple candidates (user bought same plan twice in the window), pick closest by time
  candidates.sort((a, b) => {
    const aMs = Math.abs(new Date(a.plan_date).getTime() - ODS_OFFSET_MS - txDateMs);
    const bMs = Math.abs(new Date(b.plan_date).getTime() - ODS_OFFSET_MS - txDateMs);
    return aMs - bMs;
  });

  return candidates[0];
}

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('DB connected\n');

  const txns = await Transaction
    .find(POLLER_FAILED_FILTER)
    .populate('user', 'email username')
    .sort({ createdAt: -1 })
    .lean();

  console.log(`Transactions to cross-reference: ${txns.length}\n`);

  // ── Step 1: Download all ODS transactions once ──────────────────────────
  const odsRows = await downloadOdsTransactions();

  // ── Step 2: Match locally ────────────────────────────────────────────────
  const results  = [];
  let delivered  = 0;
  let notFailed  = 0; // NOT delivered or not found
  let uncertain  = 0;

  console.log('Matching transactions...\n');
  console.log('─── RESULTS ─────────────────────────────────────────────────────');

  for (let i = 0; i < txns.length; i++) {
    const tx    = txns[i];
    const match = findOdsMatch(tx, odsRows);

    let category, action, odsInfo;

    if (!match) {
      category = 'NOT FOUND';
      action   = 'CLEAR — no matching ODS record, data likely not delivered';
      notFailed++;
      odsInfo  = 'No OurDataStore record within ±2h for this phone number';
    } else if (match.plan_status === 1) {
      category = 'DELIVERED';
      action   = 'DEDUCT WALLET — data was delivered, charge should stand';
      delivered++;
      odsInfo  = `ODS: ${fmtDate(match.plan_date)} | plan_status=1 (Success) | transid: ${match.transid || '—'} | ODS amount: ${match.amount}`;
    } else if (match.plan_status === 2) {
      category = 'FAILED';
      action   = 'CLEAR — ODS confirms data was not delivered, refund was correct';
      notFailed++;
      odsInfo  = `ODS: ${fmtDate(match.plan_date)} | plan_status=2 (Failed) | transid: ${match.transid || '—'}`;
    } else {
      category = 'UNCERTAIN';
      action   = 'MANUAL CHECK — ODS shows plan_status=' + match.plan_status + ' (Processing or unknown)';
      uncertain++;
      odsInfo  = `ODS: ${fmtDate(match.plan_date)} | plan_status=${match.plan_status} | transid: ${match.transid || '—'}`;
    }

    const row = {
      txId:    tx._id.toString(),
      date:    fmtDate(tx.createdAt),
      user:    tx.user?.email || '—',
      phone:   tx.phone,
      amount:  tx.amount,
      category,
      action,
      odsInfo,
      odsTransid: match?.transid || null,
    };
    results.push(row);

    const flag = category === 'DELIVERED' ? '⚠ ' : category === 'UNCERTAIN' ? '? ' : '  ';
    console.log(`${flag}[${String(i + 1).padStart(3)}] ${category.padEnd(11)} ₦${String(tx.amount).padStart(6)} | ${tx.phone} | ${fmtDate(tx.createdAt)}`);
    if (category !== 'NOT FOUND' && category !== 'FAILED') {
      console.log(`         ${action}`);
      console.log(`         ${odsInfo}`);
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  const totalDeductAmount = results
    .filter(r => r.category === 'DELIVERED')
    .reduce((s, r) => s + (r.amount || 0), 0);

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  DELIVERED  (deduct wallet) : ${String(delivered).padStart(4)}   ₦${totalDeductAmount.toLocaleString()}`);
  console.log(`  FAILED / NOT FOUND (clear) : ${String(notFailed).padStart(4)}`);
  console.log(`  UNCERTAIN  (manual check)  : ${String(uncertain).padStart(4)}`);
  console.log(`  TOTAL                      : ${String(txns.length).padStart(4)}`);

  // ── Save results ─────────────────────────────────────────────────────────
  const outPath = path.join(__dirname, 'crossref-results.json');
  fs.writeFileSync(outPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    summary: { delivered, cleared: notFailed, uncertain, total: txns.length, totalDeductAmount },
    results,
  }, null, 2));
  console.log(`\nFull results saved to: ${outPath}`);
  console.log('\nNext step: go to Flagged Transactions and process each entry based on the above.');

  process.exit(0);
}

run().catch(err => { console.error(err); process.exit(1); });
