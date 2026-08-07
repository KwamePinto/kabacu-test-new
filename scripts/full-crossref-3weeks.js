/**
 * Comprehensive 3-week cross-reference: Kabacu DATA transactions vs OurDataStore
 *
 * Covers ALL failed and success wallet+DATA transactions for the past 3 weeks.
 *
 * Categories reported:
 *   DAMAGE     — Kabacu status=failed (wallet refunded) but ODS shows data DELIVERED
 *                → company lost money; admin needs to re-deduct wallet
 *   CORRECT    — Kabacu status=failed and ODS also shows failed/not found
 *                → refund was correct, no action needed
 *   OK         — Kabacu status=success and ODS also shows delivered
 *                → everything is consistent
 *   SUSPICIOUS — Kabacu status=success but ODS shows failed or not found
 *                → user may have been charged without receiving data (investigate)
 *   UNCERTAIN  — ODS record found but plan_status=3 (still processing)
 *
 * Run: node scripts/full-crossref-3weeks.js
 */
require('dotenv').config();
const mongoose    = require('mongoose');
const fs          = require('fs');
const path        = require('path');
const Transaction = require('../server/models/TransactionModel');
require('../server/models/UserModel');
const { fetchDataTransactions } = require('../server/services/ourdatastore');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Date range ────────────────────────────────────────────────────────────────
const THREE_WEEKS_AGO = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000);
const WINDOW_MS       = 2  * 60 * 60 * 1000; // ±2h match window

// ODS plan_date is stored as "YYYY-MM-DD HH:MM:SS" in Nigeria time (UTC+1).
// Parsing without timezone info gives local machine time (wrong on non-UTC machines).
// Appending '+01:00' forces correct interpretation regardless of machine timezone.
const parseOdsDate = d => new Date(d.replace(' ', 'T') + '+01:00');

function normalisePhone(p) {
  return String(p || '').replace(/\D/g, '').replace(/^234/, '0');
}

function fmtDate(d) {
  return new Date(d).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// ── Download all ODS transactions since the cutoff ────────────────────────────
async function downloadOdsTransactions() {
  const cutoff = new Date(THREE_WEEKS_AGO.getTime() - WINDOW_MS); // extra buffer
  const all    = [];
  let page     = 1;

  console.log(`Downloading OurDataStore transactions (since ${fmtDate(THREE_WEEKS_AGO)})...`);
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
    process.stdout.write(`\r  Downloaded: ${all.length} records (page ${page})`);

    const oldest = rows[rows.length - 1];
    if (oldest?.plan_date) {
      if (parseOdsDate(oldest.plan_date) < cutoff) break;
    }

    page++;
    await sleep(800); // gentle rate-limit
  }

  console.log(`\n  Total ODS records: ${all.length}\n`);
  return all;
}

// ── Match a single Kabacu transaction against the ODS rows ──────────────────
function findOdsMatch(tx, odsRows) {
  const txPhone  = normalisePhone(tx.phone);
  const txDateMs = new Date(tx.createdAt).getTime();

  const candidates = odsRows.filter(row => {
    if (!txPhone || normalisePhone(row.plan_phone) !== txPhone) return false;
    const odsMs = parseOdsDate(row.plan_date).getTime();
    return Math.abs(odsMs - txDateMs) <= WINDOW_MS;
  });

  if (!candidates.length) return null;

  // Multiple candidates: pick closest by time
  candidates.sort((a, b) => {
    const aMs = Math.abs(parseOdsDate(a.plan_date).getTime() - txDateMs);
    const bMs = Math.abs(parseOdsDate(b.plan_date).getTime() - txDateMs);
    return aMs - bMs;
  });
  return candidates[0];
}

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('DB connected\n');

  // ── 1. Fetch all wallet DATA transactions from the past 3 weeks ──────────
  console.log('Fetching Kabacu transactions (last 3 weeks)...');
  const [failedTxns, successTxns] = await Promise.all([
    Transaction.find({
      paymentMethod: 'wallet',
      status:        'failed',
      createdAt:     { $gte: THREE_WEEKS_AGO },
    }).populate('user', 'email username').sort({ createdAt: -1 }).lean(),

    Transaction.find({
      paymentMethod: 'wallet',
      status:        'success',
      createdAt:     { $gte: THREE_WEEKS_AGO },
    }).populate('user', 'email username').sort({ createdAt: -1 }).lean(),
  ]);

  // Filter to DATA transactions only (has a phone number)
  const failedData  = failedTxns.filter(tx => tx.phone && tx.phone.trim().length > 0);
  const successData = successTxns.filter(tx => tx.phone && tx.phone.trim().length > 0);

  console.log(`  Failed  wallet+DATA txns: ${failedData.length}`);
  console.log(`  Success wallet+DATA txns: ${successData.length}`);
  console.log(`  Total to cross-reference: ${failedData.length + successData.length}\n`);

  // ── 2. Download ODS ──────────────────────────────────────────────────────
  const odsRows = await downloadOdsTransactions();

  // ── 3. Cross-reference ───────────────────────────────────────────────────
  const results = {
    damage:     [], // failed on Kabacu, delivered on ODS → COMPANY LOST MONEY
    correct:    [], // failed on Kabacu, failed/not-found on ODS → refund was right
    ok:         [], // success on Kabacu, delivered on ODS → all good
    suspicious: [], // success on Kabacu, ODS failed/not-found → user charged without data
    uncertain:  [], // ODS record found but plan_status=3 (processing)
  };

  console.log('Cross-referencing FAILED transactions...');
  for (const tx of failedData) {
    const match = findOdsMatch(tx, odsRows);
    const alreadyHandled = tx.apiResponse?.adminDeducted || tx.adminCleared;

    if (!match) {
      results.correct.push({ tx, match: null, note: 'No ODS record — refund was correct' });
    } else if (match.plan_status === 1) {
      results.damage.push({ tx, match, note: 'ODS confirms DELIVERED — user was refunded but data was sent', alreadyHandled });
    } else if (match.plan_status === 2) {
      results.correct.push({ tx, match, note: 'ODS also failed — refund was correct' });
    } else {
      results.uncertain.push({ tx, match, note: `ODS plan_status=${match.plan_status} (still processing or unknown)` });
    }
  }

  console.log('Cross-referencing SUCCESS transactions...');
  for (const tx of successData) {
    const match = findOdsMatch(tx, odsRows);

    if (!match) {
      results.suspicious.push({ tx, match: null, note: 'No ODS record — success on Kabacu but not found on ODS' });
    } else if (match.plan_status === 1) {
      results.ok.push({ tx, match, note: 'ODS also success — consistent' });
    } else if (match.plan_status === 2) {
      results.suspicious.push({ tx, match, note: 'ODS shows FAILED but Kabacu shows success — user may have been charged without data' });
    } else {
      results.uncertain.push({ tx, match, note: `ODS plan_status=${match.plan_status} on a success transaction` });
    }
  }

  // ── 4. Print summary ─────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('FULL 3-WEEK CROSS-REFERENCE RESULTS');
  console.log('══════════════════════════════════════════════════════════════════\n');

  // DAMAGE — most critical
  const totalDamage = results.damage.reduce((s, r) => s + (r.tx.amount || 0), 0);
  const newDamage   = results.damage.filter(r => !r.alreadyHandled);
  const handledDamage = results.damage.filter(r => r.alreadyHandled);

  console.log(`⚠  DAMAGE (data delivered but wallet refunded): ${results.damage.length} transactions`);
  console.log(`   Already admin-handled : ${handledDamage.length}`);
  console.log(`   Still needs action    : ${newDamage.length}  ← RE-DEDUCT THESE`);
  console.log(`   Total amount affected : ₦${totalDamage.toLocaleString()}\n`);

  if (newDamage.length > 0) {
    console.log('   ── Unhandled DAMAGE transactions ───────────────────────────');
    for (const r of newDamage) {
      console.log(`   [${fmtDate(r.tx.createdAt)}] ₦${r.tx.amount} | ${r.tx.phone} | User: ${r.tx.user?.email || '—'}`);
      console.log(`      ODS: ${fmtDate(r.match.plan_date)} | plan_status=1 | transid: ${r.match.transid || '—'}`);
      console.log(`      TX ID: ${r.tx._id}`);
    }
    console.log();
  }

  if (handledDamage.length > 0) {
    console.log('   ── Already-handled DAMAGE transactions (admin-deducted / cleared) ──');
    for (const r of handledDamage) {
      const flag = r.tx.apiResponse?.adminDeducted ? 'adminDeducted' : 'adminCleared';
      console.log(`   [${fmtDate(r.tx.createdAt)}] ₦${r.tx.amount} | ${r.tx.phone} | ${r.tx.user?.email || '—'} [${flag}]`);
    }
    console.log();
  }

  // SUSPICIOUS
  console.log(`?  SUSPICIOUS (success on Kabacu, ODS failed/not-found): ${results.suspicious.length} transactions`);
  if (results.suspicious.length > 0) {
    for (const r of results.suspicious) {
      console.log(`   [${fmtDate(r.tx.createdAt)}] ₦${r.tx.amount} | ${r.tx.phone} | ${r.tx.user?.email || '—'}`);
      console.log(`      ${r.note}`);
    }
  }
  console.log();

  // UNCERTAIN
  console.log(`?  UNCERTAIN (ODS still processing): ${results.uncertain.length} transactions\n`);

  // CORRECT + OK
  console.log(`✓  CORRECT refunds (failed on both sides): ${results.correct.length} transactions`);
  console.log(`✓  OK (success on both sides)            : ${results.ok.length} transactions`);

  // TOTALS
  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('TOTALS');
  console.log('══════════════════════════════════════════════════════════════════');
  const total = failedData.length + successData.length;
  console.log(`  Failed checked    : ${failedData.length}`);
  console.log(`  Success checked   : ${successData.length}`);
  console.log(`  DAMAGE            : ${results.damage.length} (₦${totalDamage.toLocaleString()}) — new: ${newDamage.length}`);
  console.log(`  CORRECT refunds   : ${results.correct.length}`);
  console.log(`  OK successes      : ${results.ok.length}`);
  console.log(`  SUSPICIOUS        : ${results.suspicious.length}`);
  console.log(`  UNCERTAIN         : ${results.uncertain.length}`);
  console.log(`  Total cross-ref'd : ${total}`);

  // ── 5. Save full results JSON ─────────────────────────────────────────────
  const outPath = path.join(__dirname, 'full-crossref-results.json');
  const toRow = r => ({
    txId:       r.tx._id.toString(),
    date:       fmtDate(r.tx.createdAt),
    user:       r.tx.user?.email || '—',
    phone:      r.tx.phone,
    amount:     r.tx.amount,
    kabacuStatus: r.tx.status,
    odsStatus:  r.match ? r.match.plan_status : null,
    odsDate:    r.match ? fmtDate(r.match.plan_date) : null,
    odsTransid: r.match?.transid || null,
    alreadyHandled: r.alreadyHandled || false,
    note:       r.note,
  });

  fs.writeFileSync(outPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    rangeStart:  THREE_WEEKS_AGO.toISOString(),
    summary: {
      damage: results.damage.length, newDamage: newDamage.length, totalDamageAmount: totalDamage,
      correct: results.correct.length, ok: results.ok.length,
      suspicious: results.suspicious.length, uncertain: results.uncertain.length,
    },
    damage:     results.damage.map(toRow),
    suspicious: results.suspicious.map(toRow),
    uncertain:  results.uncertain.map(toRow),
    correct:    results.correct.map(toRow),
    ok:         results.ok.map(toRow),
  }, null, 2));

  console.log(`\nFull results saved to: ${outPath}`);
  console.log('\nNext steps:');
  console.log('  1. For each DAMAGE transaction with alreadyHandled=false → go to Flagged Transactions and Deduct Wallet');
  console.log('  2. Review SUSPICIOUS transactions — user may have been charged without receiving data');
  console.log('  3. UNCERTAIN transactions — check ODS dashboard manually\n');

  process.exit(0);
}

run().catch(err => { console.error(err); process.exit(1); });
