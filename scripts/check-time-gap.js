/**
 * Check the actual time gap between Kabacu createdAt and ODS plan_date
 * for a sample of success transactions, to understand if the ±2h window is the issue.
 */
require('dotenv').config();
const mongoose    = require('mongoose');
const Transaction = require('../server/models/TransactionModel');
const { fetchDataTransactions } = require('../server/services/ourdatastore');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm  = p  => String(p || '').replace(/\D/g, '').replace(/^234/, '0');
const parseOdsDate = d => new Date(d.replace(' ', 'T') + '+01:00');

async function run() {
  await mongoose.connect(process.env.MONGO_URI);

  // Get a sample of recent success transactions (use ones we know are suspicious)
  const txns = await Transaction.find({
    paymentMethod: 'wallet',
    status:        'success',
    phone:         { $exists: true, $ne: '' },
    createdAt:     { $gte: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) }
  }).sort({ createdAt: -1 }).limit(20).lean();

  console.log(`Checking ${txns.length} recent success transactions against ODS (no time filter)...\n`);

  // Download ODS records for the last 3 days only (small set for speed)
  const odsRows = [];
  const cutoff  = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);

  for (let page = 1; page <= 10; page++) {
    const r = await fetchDataTransactions({ page, status: 'ALL', perPage: 100 });
    const rows = r.data || [];
    if (!rows.length) break;
    odsRows.push(...rows);
    const oldest = rows[rows.length - 1];
    if (oldest?.plan_date) {
      if (parseOdsDate(oldest.plan_date) < cutoff) break;
    }
    await sleep(500);
  }
  console.log(`Downloaded ${odsRows.length} ODS records for the last 3-4 days.\n`);

  // For each Kabacu success, find ALL ODS records for the same phone (no time limit)
  const gaps = [];
  for (const tx of txns) {
    const txPhone  = norm(tx.phone);
    const txDateMs = new Date(tx.createdAt).getTime();

    const candidates = odsRows.filter(row => norm(row.plan_phone) === txPhone);
    if (!candidates.length) {
      gaps.push({ tx, gap: null, note: 'NO ODS record found for this phone at all' });
      continue;
    }

    // Find the closest ODS record by time (regardless of window)
    candidates.sort((a, b) => {
      const aMs = Math.abs(parseOdsDate(a.plan_date).getTime() - txDateMs);
      const bMs = Math.abs(parseOdsDate(b.plan_date).getTime() - txDateMs);
      return aMs - bMs;
    });

    const best    = candidates[0];
    const odsUtc  = parseOdsDate(best.plan_date).getTime();
    const gapMin  = Math.round((odsUtc - txDateMs) / 60000); // negative = ODS before Kabacu
    const gapAbs  = Math.abs(gapMin);

    gaps.push({
      phone:    tx.phone,
      kabacu:   new Date(tx.createdAt).toISOString(),
      odsNg:    best.plan_date,
      gapMin,
      gapAbs,
      odsStatus: best.plan_status,
      withinWindow: gapAbs <= 120,
    });
  }

  // Print results
  gaps.forEach(g => {
    if (g.note) {
      console.log(`${g.tx.phone} | ${new Date(g.tx.createdAt).toISOString()} → NO ODS record`);
    } else {
      const flag = g.withinWindow ? '✓' : `✗ (${g.gapAbs}min gap)`;
      console.log(`${g.phone} | Kabacu: ${g.kabacu.slice(11,16)} UTC | ODS: ${g.odsNg} | gap: ${g.gapMin >= 0 ? '+' : ''}${g.gapMin}min | ODS status: ${g.odsStatus} | ${flag}`);
    }
  });

  const found     = gaps.filter(g => !g.note);
  const inWindow  = found.filter(g => g.withinWindow).length;
  const outside   = found.filter(g => !g.withinWindow);
  console.log(`\nSummary: ${found.length}/${txns.length} had ODS match | ${inWindow} within ±2h | ${outside.length} outside ±2h`);
  if (outside.length > 0) {
    const avgGap = Math.round(outside.reduce((s, g) => s + g.gapAbs, 0) / outside.length);
    console.log(`Average gap for outside-window matches: ${avgGap} min (${Math.round(avgGap/60)}h)`);
  }

  process.exit(0);
}

run().catch(e => { console.error(e.message); process.exit(1); });
