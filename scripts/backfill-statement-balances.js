/**
 * Reconstructs before/after wallet balances for historic statement rows.
 *
 *   node scripts/backfill-statement-balances.js            # dry run, writes nothing
 *   node scripts/backfill-statement-balances.js --apply    # write
 *   node scripts/backfill-statement-balances.js --user <id>
 *
 * ── How it works ─────────────────────────────────────────────────────────────
 * The only balance we know for certain is the wallet's CURRENT balance, so the
 * ledger is replayed BACKWARDS from it: for each movement, newest first, the
 * after-balance is the running figure and the before-balance is that minus the
 * movement's effect.
 *
 * ── Why it refuses to fill some users ────────────────────────────────────────
 * Summing every recorded NAIRA movement should equal the current balance. When
 * it doesn't, money moved in a way nothing recorded (older manual adjustments,
 * pre-ledger history), and every reconstructed figure for that user would be
 * silently wrong by the residual. On a financial statement a confidently wrong
 * number is worse than a blank, so those users are skipped and reported.
 *
 * Only NAIRA is reconstructed. Reward-point and USDT/BTT movements are not
 * consistently recorded anywhere, so they cannot be replayed honestly.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const Wallet      = require('../server/models/WalletModal');
const Transaction = require('../server/models/TransactionModel');
const TopUp       = require('../server/models/TopUpModal');
const Conversion  = require('../server/models/ConversionModal');

const APPLY     = process.argv.includes('--apply');
const ONE_USER  = (() => {
  const i = process.argv.indexOf('--user');
  return i !== -1 ? process.argv[i + 1] : null;
})();

/** Tolerance for floating-point drift when reconciling (kobo-level). */
const EPSILON = 0.01;

/**
 * Signed effect of a transaction on the NAIRA balance.
 * Returns null for rows that never moved money.
 */
function transactionDelta(t) {
  if (t.walletType && t.walletType !== 'NAIRA') return null;

  const ar = t.apiResponse || {};
  const ref = t.reference || '';

  // Admin credits / refunds put money in
  if (ar.adminRefund || /^ADMIN-(REFUND|CREDIT)/.test(ref)) return +(t.amount || 0);
  // Admin deductions take money out
  if (ar.adminDeducted) return -(t.amount || 0);

  // A refunded purchase debited then credited the same amount: net zero, and
  // it already carries its own before/after, so leave it alone.
  if (t.status === 'refunded') return 0;

  // Failed purchases were refunded in-flight — net zero.
  if (t.status === 'failed') return 0;

  // Pending never settled.
  if (t.status === 'pending') return 0;

  if (t.status === 'success') return -(t.amount || 0);

  return 0;
}

function topupDelta(tp) {
  if ((tp.balanceType || 'NAIRA') !== 'NAIRA') return null;
  if (tp.status !== 'COMPLETED') return null;
  const amt = tp.nairaAmount != null ? tp.nairaAmount : (tp.amount || 0) / 100;
  return +amt;
}

function conversionDelta(cv) {
  if (cv.status !== 'COMPLETED') return null;
  return +(cv.nairaAmount || 0);
}

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  console.log(`connected — ${APPLY ? 'APPLY (will write)' : 'DRY RUN (writes nothing)'}\n`);

  const walletFilter = ONE_USER ? { user: ONE_USER } : {};
  const wallets = await Wallet.find(walletFilter).select('user balances').lean();
  console.log(`wallets to examine: ${wallets.length}\n`);

  let reconciled = 0, skipped = 0, noMovements = 0;
  let txFilled = 0, tpFilled = 0, cvFilled = 0;
  const residuals = [];

  for (const w of wallets) {
    const uid = w.user;
    if (!uid) continue;

    const [txs, tps, cvs] = await Promise.all([
      Transaction.find({ user: uid }).sort({ createdAt: 1 }).lean(),
      TopUp.find({ user: uid }).sort({ createdAt: 1 }).lean(),
      Conversion.find({ user: uid }).sort({ createdAt: 1 }).lean(),
    ]);

    const entries = [];
    txs.forEach(t => {
      const d = transactionDelta(t);
      if (d === null) return;
      entries.push({ kind: 'tx', id: t._id, at: t.createdAt, delta: d,
                     hasBoth: t.balanceBefore != null && t.balanceAfter != null });
    });
    tps.forEach(t => {
      const d = topupDelta(t);
      if (d === null) return;
      entries.push({ kind: 'tp', id: t._id, at: t.createdAt, delta: d,
                     hasBoth: t.balanceBefore != null && t.balanceAfter != null });
    });
    cvs.forEach(c => {
      const d = conversionDelta(c);
      if (d === null) return;
      entries.push({ kind: 'cv', id: c._id, at: c.createdAt, delta: d,
                     hasBoth: c.balanceBefore != null && c.balanceAfter != null });
    });

    if (!entries.length) { noMovements++; continue; }

    entries.sort((a, b) => new Date(a.at) - new Date(b.at));

    const current = (w.balances && w.balances.NAIRA) || 0;
    const net = entries.reduce((s, e) => s + e.delta, 0);
    const residual = current - net;

    // The replay must account for the whole balance, otherwise every figure
    // derived from it is off by the residual.
    if (Math.abs(residual) > EPSILON) {
      skipped++;
      residuals.push({ user: String(uid), residual, movements: entries.length, current });
      continue;
    }

    reconciled++;

    // Walk backwards from the current balance.
    let running = current;
    const writes = { tx: [], tp: [], cv: [] };

    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      const after  = running;
      const before = running - e.delta;
      running = before;

      // Never overwrite a figure that was captured live.
      if (!e.hasBoth) {
        writes[e.kind].push({
          updateOne: {
            filter: { _id: e.id },
            update: { $set: { balanceBefore: before, balanceAfter: after, balanceSource: 'backfill' } },
          },
        });
      }
    }

    txFilled += writes.tx.length;
    tpFilled += writes.tp.length;
    cvFilled += writes.cv.length;

    if (APPLY) {
      if (writes.tx.length) await Transaction.bulkWrite(writes.tx, { ordered: false });
      if (writes.tp.length) await TopUp.bulkWrite(writes.tp,       { ordered: false });
      if (writes.cv.length) await Conversion.bulkWrite(writes.cv,  { ordered: false });
    }
  }

  console.log('WALLETS');
  console.log(`  reconciled (backfilled)   ${reconciled}`);
  console.log(`  skipped (unexplained)     ${skipped}`);
  console.log(`  no NAIRA movements        ${noMovements}`);

  console.log('\nROWS ' + (APPLY ? 'WRITTEN' : 'THAT WOULD BE WRITTEN'));
  console.log(`  transactions              ${txFilled}`);
  console.log(`  topups                    ${tpFilled}`);
  console.log(`  conversions               ${cvFilled}`);
  console.log(`  total                     ${txFilled + tpFilled + cvFilled}`);

  if (residuals.length) {
    residuals.sort((a, b) => Math.abs(b.residual) - Math.abs(a.residual));
    console.log(`\nSKIPPED — ledger does not explain the balance (top 15 of ${residuals.length})`);
    console.log('  user                       movements     current    residual');
    residuals.slice(0, 15).forEach(r => {
      console.log(`  ${r.user.padEnd(26)} ${String(r.movements).padStart(9)} ${r.current.toFixed(2).padStart(11)} ${r.residual.toFixed(2).padStart(11)}`);
    });
    const total = residuals.reduce((s, r) => s + Math.abs(r.residual), 0);
    console.log(`  unexplained across all skipped users: ${total.toFixed(2)}`);
  }

  if (!APPLY) console.log('\nDRY RUN — nothing was written. Re-run with --apply.');

  await mongoose.disconnect();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
