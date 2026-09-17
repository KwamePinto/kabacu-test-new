/**
 * One-time migration: referral reward gate moves from minimum SPEND to
 * minimum PURCHASE COUNT.
 *
 *   node scripts/migrate-referral-purchase-count.js              # dry run
 *   node scripts/migrate-referral-purchase-count.js --commit
 *   node scripts/migrate-referral-purchase-count.js --commit --count=3
 *
 * Run from the project root so .env resolves.
 *
 * Two jobs:
 *
 *  1. Settings — write `minPurchaseCount` and drop the dead
 *     `minPurchaseAmount`. The old value is NOT carried across: it was 200
 *     Naira, and 200 *purchases* is a completely different, unreachable bar
 *     (the whole database holds ~2,375 purchases across ~569 buyers, so
 *     nobody has ever made 200). It defaults to 1 — first purchase qualifies,
 *     the closest thing to current behaviour — and --count=N sets it to
 *     whatever you actually want.
 *
 *  2. Backfill User.purchaseCount from transaction history. Without this,
 *     every existing customer starts at zero: someone who has bought nine
 *     times would look like a new account the moment an admin sets the
 *     threshold above 1, and their referrer's reward would be pushed further
 *     away by the migration itself.
 *
 *     What counts as a purchase here: status 'success' AND the row names a
 *     product (single `product`, or a non-empty `products` array). That
 *     excludes wallet top-ups — which live in their own collection but also
 *     leave productless rows here — and the productless manual rows written
 *     by the admin damage-control and transaction tools, so an admin
 *     adjustment cannot push a user toward someone's payout.
 *
 *     From here on the counter is maintained live by
 *     referralService.handlePurchase and this history filter is never
 *     consulted again — it exists only to seed accounts that predate the
 *     field. Re-running is safe: counts are SET from history, not
 *     incremented, so a second run writes the same numbers.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const COMMIT = process.argv.includes('--commit');
const countArg = process.argv.find((a) => a.startsWith('--count='));
const TARGET_COUNT = countArg ? Math.max(0, Math.round(Number(countArg.split('=')[1]) || 0)) : 1;

/* A purchase, as opposed to a top-up or an admin adjustment. See the note above. */
const PURCHASE_FILTER = {
  status: 'success',
  $or: [
    { product: { $exists: true, $ne: null } },
    { 'products.0': { $exists: true } },
  ],
};

async function main() {
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI is not set. Run this from the project root.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
  const db = mongoose.connection.db;
  console.log(COMMIT ? 'MODE: COMMIT\n' : 'MODE: DRY RUN — nothing will be written\n');

  /* ── 1. Settings ──────────────────────────────────────────────────────── */
  const settings = await db.collection('referralsettings').findOne({});
  if (!settings) {
    console.log('No referral settings document yet — it will be created with defaults on first use.\n');
  } else {
    console.log('Settings:');
    console.log('  old minPurchaseAmount : ' + settings.minPurchaseAmount + '   (Naira, being removed)');
    console.log('  new minPurchaseCount  : ' + TARGET_COUNT +
      (TARGET_COUNT === 1 ? '   (first purchase qualifies)' : '   (purchases required)'));
    if (COMMIT) {
      await db.collection('referralsettings').updateOne(
        { _id: settings._id },
        { $set: { minPurchaseCount: TARGET_COUNT }, $unset: { minPurchaseAmount: '' } },
      );
      console.log('  written.');
    }
    console.log('');
  }

  /* ── 2. Backfill purchase counts ──────────────────────────────────────── */
  const perUser = await db.collection('transactions').aggregate([
    { $match: PURCHASE_FILTER },
    { $group: { _id: '$user', n: { $sum: 1 } } },
  ]).toArray();

  const withUser = perUser.filter((r) => r._id);
  const total = withUser.reduce((s, r) => s + r.n, 0);
  console.log('Backfill: ' + total + ' purchases across ' + withUser.length + ' accounts');

  const top = [...withUser].sort((a, b) => b.n - a.n).slice(0, 5);
  console.log('  busiest accounts: ' + top.map((r) => r.n).join(', '));

  /* Only accounts that are actually referred matter for a payout, so report
     those separately — it is the number an admin needs to see before picking
     a threshold that could strand people mid-way. */
  const pending = await db.collection('referrals').find({ status: 'pending' }).toArray();
  const byId = new Map(withUser.map((r) => [String(r._id), r.n]));
  const pendingCounts = pending.map((r) => byId.get(String(r.referred)) || 0);
  console.log('  pending referrals: ' + pending.length +
    ' — their referees\' purchase counts: [' + pendingCounts.join(', ') + ']');
  console.log('  of those, ' + pendingCounts.filter((n) => n >= TARGET_COUNT).length +
    ' already meet a threshold of ' + TARGET_COUNT +
    ' and will pay out on their referee\'s next purchase.');

  if (COMMIT && withUser.length) {
    const ops = withUser.map((r) => ({
      updateOne: {
        filter: { _id: r._id },
        update: { $set: { purchaseCount: r.n, hasMadeFirstPurchase: true } },
      },
    }));
    const res = await db.collection('users').bulkWrite(ops, { ordered: false });
    console.log('  updated ' + res.modifiedCount + ' user document(s).');
  }

  if (!COMMIT) console.log('\nDry run only. Re-run with --commit to apply.');
  await mongoose.disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
