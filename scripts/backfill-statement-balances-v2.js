/**
 * Fills in the blank Bal. Before / Bal. After cells on the admin account
 * statement, for every wallet type that can be reconstructed honestly.
 *
 *   node scripts/backfill-statement-balances-v2.js                 # dry run
 *   node scripts/backfill-statement-balances-v2.js --apply
 *   node scripts/backfill-statement-balances-v2.js --user <id>
 *
 * ── What this fixes that v1 did not ─────────────────────────────────────────
 *   1. v1 only handled NAIRA. USDT and BTT top-ups were left blank.
 *   2. v1 skipped rows that never moved money (FAILED top-ups), so they showed
 *      a dash. They now carry before == after, which is both truthful and
 *      readable: the balance genuinely did not change.
 *   3. v1 ran once, so anything created afterwards is blank again. This is
 *      re-runnable and only touches rows that are still empty.
 *
 * ── Units (verified against live, do not "simplify" these) ──────────────────
 *   NAIRA top-ups   `amount` is KOBO; `nairaAmount` holds the naira value.
 *   USDT/BTT top-ups `amount` is the RAW token amount, NOT kobo.
 *   Mixing these up silently corrupts every balance downstream.
 *
 * ── Why some rows are still skipped ─────────────────────────────────────────
 *   The replay walks backwards from the wallet's current balance. If the
 *   recorded movements don't sum to that balance, money moved in a way nothing
 *   recorded, and every derived figure would be wrong by the residual. Those
 *   wallets are reported, not guessed at.
 *
 *   RP is never reconstructed: claiming reward points moves money into the RP
 *   wallet without writing any record, so its history genuinely cannot be
 *   rebuilt from the data that exists.
 *
 *   PENDING top-ups are left blank on purpose. They are not final — writing a
 *   balance now would become a lie if the payment later completes.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const Wallet      = require('../server/models/WalletModal');
const Transaction = require('../server/models/TransactionModel');
const TopUp       = require('../server/models/TopUpModal');
const Conversion  = require('../server/models/ConversionModal');

const APPLY    = process.argv.includes('--apply');
const ONE_USER = (() => {
  const i = process.argv.indexOf('--user');
  return i !== -1 ? process.argv[i + 1] : null;
})();

const EPSILON = 0.01;

/** Wallet types this script is willing to rebuild. RP is excluded — see header. */
const TYPES = ['NAIRA', 'USDT', 'BTT'];

/** Naira value of a top-up. NAIRA rows are kobo; token rows are raw. */
function topupAmount(tp) {
  if ((tp.balanceType || 'NAIRA') === 'NAIRA') {
    return tp.nairaAmount != null ? tp.nairaAmount : (tp.amount || 0) / 100;
  }
  return tp.amount || 0;
}

/** Signed NAIRA effect of a transaction, or null if it isn't a NAIRA mover. */
function transactionDelta(t) {
  if ((t.walletType || 'NAIRA') !== 'NAIRA') return null;
  const ar = t.apiResponse || {};
  const ref = t.reference || '';
  if (ar.adminRefund || /^ADMIN-(REFUND|CREDIT)/.test(ref)) return +(t.amount || 0);
  if (ar.adminDeducted) return -(t.amount || 0);
  // failed/refunded were reversed in-flight; pending never settled
  if (t.status === 'failed' || t.status === 'refunded' || t.status === 'pending') return 0;
  if (t.status === 'success') return -(t.amount || 0);
  return 0;
}

/**
 * Every movement affecting one wallet type, oldest first.
 * `delta` may be 0 for rows that are final but never moved money — those still
 * get before == after so the statement shows figures instead of dashes.
 */
function buildEntries(type, txs, tps, cvs) {
  const out = [];

  if (type === 'NAIRA') {
    txs.forEach(t => {
      const d = transactionDelta(t);
      if (d === null) return;
      out.push({ coll: 'tx', id: t._id, at: t.createdAt, delta: d,
                 hasBoth: t.balanceBefore != null && t.balanceAfter != null });
    });
  }

  tps.forEach(t => {
    if ((t.balanceType || 'NAIRA') !== type) return;
    if (t.status === 'PENDING') return;                 // not final, leave blank
    const amt = topupAmount(t);
    const delta = t.status === 'COMPLETED' ? +amt : 0;  // FAILED moved nothing
    out.push({ coll: 'tp', id: t._id, at: t.createdAt, delta,
               hasBoth: t.balanceBefore != null && t.balanceAfter != null });
  });

  cvs.forEach(c => {
    if (c.status !== 'COMPLETED') return;
    if (type === 'NAIRA') {
      out.push({ coll: 'cv', id: c._id, at: c.createdAt, delta: +(c.nairaAmount || 0),
                 hasBoth: c.balanceBefore != null && c.balanceAfter != null });
    } else if (type === 'USDT') {
      // Conversions spend USDT. Tracked in the conversion's own USDT columns.
      out.push({ coll: 'cv', id: c._id, at: c.createdAt, delta: -(c.usdtAmount || 0), usdtSide: true,
                 hasBoth: c.usdtBalanceBefore != null && c.usdtBalanceAfter != null });
    }
  });

  out.sort((a, b) => new Date(a.at) - new Date(b.at));
  return out;
}

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  console.log(`connected — ${APPLY ? 'APPLY (will write)' : 'DRY RUN (writes nothing)'}\n`);

  const wallets = await Wallet.find(ONE_USER ? { user: ONE_USER } : {})
    .select('user balances').lean();
  console.log(`wallets to examine: ${wallets.length}\n`);

  const stats = {};
  TYPES.forEach(t => stats[t] = { reconciled: 0, skipped: 0, none: 0, rows: 0, residual: 0 });
  const skippedDetail = [];

  for (const w of wallets) {
    const uid = w.user;
    if (!uid) continue;

    const [txs, tps, cvs] = await Promise.all([
      Transaction.find({ user: uid }).sort({ createdAt: 1 }).lean(),
      TopUp.find({ user: uid }).sort({ createdAt: 1 }).lean(),
      Conversion.find({ user: uid }).sort({ createdAt: 1 }).lean(),
    ]);

    for (const type of TYPES) {
      const entries = buildEntries(type, txs, tps, cvs);
      if (!entries.length) { stats[type].none++; continue; }

      const current = (w.balances && w.balances[type]) || 0;
      const net = entries.reduce((s, e) => s + e.delta, 0);
      const residual = current - net;

      if (Math.abs(residual) > EPSILON) {
        stats[type].skipped++;
        stats[type].residual += Math.abs(residual);
        skippedDetail.push({ user: String(uid), type, residual, movements: entries.length, current });
        continue;
      }

      stats[type].reconciled++;

      // Walk backwards from the known current balance.
      let running = current;
      const ops = { tx: [], tp: [], cv: [] };

      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        const after  = running;
        const before = running - e.delta;
        running = before;

        if (e.hasBoth) continue;   // never overwrite what was captured live

        const set = e.usdtSide
          ? { usdtBalanceBefore: before, usdtBalanceAfter: after }
          : { balanceBefore: before, balanceAfter: after, balanceSource: 'backfill' };

        ops[e.coll].push({ updateOne: { filter: { _id: e.id }, update: { $set: set } } });
      }

      const total = ops.tx.length + ops.tp.length + ops.cv.length;
      stats[type].rows += total;

      if (APPLY && total) {
        if (ops.tx.length) await Transaction.bulkWrite(ops.tx, { ordered: false });
        if (ops.tp.length) await TopUp.bulkWrite(ops.tp,       { ordered: false });
        if (ops.cv.length) await Conversion.bulkWrite(ops.cv,  { ordered: false });
      }
    }
  }

  console.log('  type    reconciled  skipped  no-movement   rows ' + (APPLY ? 'written' : 'pending'));
  TYPES.forEach(t => {
    const s = stats[t];
    console.log(`  ${t.padEnd(7)} ${String(s.reconciled).padStart(10)} ${String(s.skipped).padStart(8)} ${String(s.none).padStart(12)} ${String(s.rows).padStart(12)}`);
  });
  const totalRows = TYPES.reduce((a, t) => a + stats[t].rows, 0);
  console.log(`\n  total rows ${APPLY ? 'written' : 'that would be written'}: ${totalRows}`);

  TYPES.forEach(t => {
    if (stats[t].skipped) {
      console.log(`  ${t}: ${stats[t].skipped} wallets unreconcilable, ${stats[t].residual.toFixed(2)} unexplained`);
    }
  });

  if (skippedDetail.length) {
    skippedDetail.sort((a, b) => Math.abs(b.residual) - Math.abs(a.residual));
    console.log('\n  worst unreconciled wallets:');
    console.log('  user                       type    movements    current   residual');
    skippedDetail.slice(0, 10).forEach(r =>
      console.log(`  ${r.user.padEnd(26)} ${r.type.padEnd(6)} ${String(r.movements).padStart(9)} ${r.current.toFixed(2).padStart(10)} ${r.residual.toFixed(2).padStart(10)}`));
  }

  if (!APPLY) console.log('\nDRY RUN — nothing written. Re-run with --apply.');

  await mongoose.disconnect();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
