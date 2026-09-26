/**
 * The three backfills live needs after the merge, before KabakuNew points at it.
 *
 *   node scripts/db-post-merge-backfills.js            # dry run
 *   node scripts/db-post-merge-backfills.js --commit
 *
 * All three fill in fields the new code reads but that live documents — written
 * by the old code — have never had. Each is idempotent: a rerun finds nothing
 * left to do rather than doing it twice.
 *
 *   1. products.country
 *      The schema defaults this to 'NG', which covers reading a product, but a
 *      default does NOT apply to a QUERY — Product.find({ country: 'NG' })
 *      matches on the stored field, so all 35 live products would be invisible
 *      to any country-filtered listing until the field actually exists.
 *
 *   2. referral codes
 *      7,191 live users have none, so the whole referral feature is inert.
 *      Written here rather than with scripts/backfill-referral-codes.js on
 *      purpose: that script checks uniqueness only against User.referralCode,
 *      and live now holds a 422-code reserved pool that must never be handed
 *      out for free. This preloads every namespace a code can already live in
 *      — issued codes, the code table, the reserved pool, and pending requests
 *      — and allocates around all of them. It writes BOTH the ReferralCode row
 *      (the authority for resolving a code) and User.referralCode (the
 *      denormalised copy the UI reads); a code in only one of the two would
 *      half-work.
 *
 *   3. users.purchaseCount / hasMadeFirstPurchase
 *      Referral rewards unlock on a purchase COUNT. Absent on every live user,
 *      these default to 0/false, which would make a customer with 50 orders
 *      look brand new and hold their referrer's reward hostage until they
 *      bought again. Counted from their real successful product purchases.
 */
require('dotenv').config();
const fs = require('fs');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');

const COMMIT = process.argv.includes('--commit');
const OLD_ENV = 'C:/Users/user/Desktop/CTC/kabacu/KabakuOld/.env';

const CODE_PREFIX = 'KB';
const CODE_DIGITS = 8;

function readEnvFile(file, key) {
  const txt = fs.readFileSync(file, 'utf8');
  const m = new RegExp('^' + key + '\\s*=\\s*(.+)$', 'm').exec(txt);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
}

function randomSystemCode() {
  let digits = '';
  for (let i = 0; i < CODE_DIGITS; i++) digits += crypto.randomInt(0, 10);
  return CODE_PREFIX + digits;
}

/* A purchase, as opposed to a wallet top-up or an admin adjustment: status
   'success' AND the row names a product. Same definition the live referral
   hook uses when it increments the counter going forward. */
const PURCHASE_FILTER = {
  status: 'success',
  $or: [{ product: { $exists: true, $ne: null } }, { 'products.0': { $exists: true } }],
};

async function main() {
  const client = new MongoClient(readEnvFile(OLD_ENV, 'MONGO_URI'), { serverSelectionTimeoutMS: 30000 });
  await client.connect();
  const db = client.db();

  console.log(COMMIT ? 'MODE: COMMIT — LIVE WILL BE WRITTEN TO\n' : 'MODE: DRY RUN — nothing will be written\n');
  console.log('  target: ' + db.databaseName + ' @ ' + (readEnvFile(OLD_ENV, 'MONGO_URI').match(/@([^:,]+)/) || [])[1] + '\n');

  // ── 1. products.country ────────────────────────────────────────────────
  console.log('── 1. products.country ' + '─'.repeat(38));
  const noCountry = { $or: [{ country: { $exists: false } }, { country: null }, { country: '' }] };
  const productsMissing = await db.collection('products').countDocuments(noCountry);
  console.log('  products without a country: ' + productsMissing + ' / ' + await db.collection('products').countDocuments());
  if (COMMIT && productsMissing) {
    const r = await db.collection('products').updateMany(noCountry, { $set: { country: 'NG' } });
    console.log('  set country=NG on ' + r.modifiedCount + ' product(s)');
  } else if (productsMissing) {
    console.log('  would set country=NG on ' + productsMissing + ' product(s)');
  }

  // ── 2. referral codes ──────────────────────────────────────────────────
  console.log('\n── 2. referral codes ' + '─'.repeat(40));
  const usersNeeding = await db.collection('users').find(
    { $or: [{ referralCode: { $exists: false } }, { referralCode: null }, { referralCode: '' }] },
    { projection: { _id: 1 } },
  ).toArray();

  /* Every namespace a code can already occupy. Missing any one of these is how
     a "free" code gets handed out on top of something already spoken for. */
  const taken = new Set();
  for (const u of await db.collection('users').find({ referralCode: { $nin: [null, ''] } }, { projection: { referralCode: 1 } }).toArray()) {
    taken.add(String(u.referralCode).toUpperCase());
  }
  const beforeTable = taken.size;
  for (const c of await db.collection('referralcodes').find({}, { projection: { code: 1 } }).toArray()) taken.add(String(c.code).toUpperCase());
  const afterTable = taken.size;
  for (const c of await db.collection('specialreferralcodes').find({}, { projection: { code: 1 } }).toArray()) taken.add(String(c.code).toUpperCase());
  const afterPool = taken.size;
  for (const r of await db.collection('referralcoderequests').find({}, { projection: { code: 1 } }).toArray()) {
    if (r.code) taken.add(String(r.code).toUpperCase());
  }

  console.log('  users needing a code:   ' + usersNeeding.length);
  console.log('  codes already in use:   ' + beforeTable + ' on users, +' + (afterTable - beforeTable) +
    ' in the code table, +' + (afterPool - afterTable) + ' reserved pool, +' + (taken.size - afterPool) + ' pending requests');
  console.log('  total blocked values:   ' + taken.size);

  const allocations = [];
  let exhausted = 0;
  for (const u of usersNeeding) {
    let code = null;
    for (let i = 0; i < 25; i++) {
      const candidate = randomSystemCode();
      if (!taken.has(candidate)) { code = candidate; taken.add(candidate); break; }
    }
    if (!code) { exhausted++; continue; }
    allocations.push({ userId: u._id, code });
  }
  console.log('  allocated:              ' + allocations.length + (exhausted ? '   (' + exhausted + ' FAILED to allocate)' : ''));

  if (COMMIT && allocations.length) {
    const now = new Date();
    for (let i = 0; i < allocations.length; i += 500) {
      const slice = allocations.slice(i, i + 500);
      await db.collection('referralcodes').insertMany(slice.map((a) => ({
        code: a.code, user: a.userId, kind: 'system', isPrimary: true,
        pricePaid: 0, rewardBonusPercent: 0, commissionBonusPercent: 0,
        specialCode: null, request: null, retiredAt: null,
        createdAt: now, updatedAt: now, __v: 0,
      })), { ordered: false });
      await db.collection('users').bulkWrite(slice.map((a) => ({
        updateOne: { filter: { _id: a.userId }, update: { $set: { referralCode: a.code } } },
      })), { ordered: false });
      process.stdout.write('\r  written: ' + Math.min(i + 500, allocations.length) + '/' + allocations.length);
    }
    console.log('');
  }

  // ── 3. purchaseCount / hasMadeFirstPurchase ────────────────────────────
  console.log('\n── 3. users.purchaseCount / hasMadeFirstPurchase ' + '─'.repeat(13));
  const perUser = await db.collection('transactions').aggregate([
    { $match: PURCHASE_FILTER },
    { $group: { _id: '$user', n: { $sum: 1 } } },
  ]).toArray();
  const withUser = perUser.filter((r) => r._id);
  const liveUserIds = new Set((await db.collection('users').find({}, { projection: { _id: 1 } }).toArray()).map((d) => String(d._id)));
  const applicable = withUser.filter((r) => liveUserIds.has(String(r._id)));

  console.log('  buyers found in transaction history: ' + withUser.length +
    '   (' + applicable.length + ' still exist as users)');
  console.log('  purchases counted:                   ' + applicable.reduce((s, r) => s + r.n, 0));
  const top = [...applicable].sort((a, b) => b.n - a.n).slice(0, 5).map((r) => r.n);
  console.log('  busiest accounts:                    ' + top.join(', '));

  if (COMMIT && applicable.length) {
    for (let i = 0; i < applicable.length; i += 500) {
      const slice = applicable.slice(i, i + 500);
      await db.collection('users').bulkWrite(slice.map((r) => ({
        updateOne: { filter: { _id: r._id }, update: { $set: { purchaseCount: r.n, hasMadeFirstPurchase: true } } },
      })), { ordered: false });
    }
    console.log('  updated ' + applicable.length + ' user(s)');
  } else if (applicable.length) {
    console.log('  would update ' + applicable.length + ' user(s)');
  }

  // ── Verify ─────────────────────────────────────────────────────────────
  if (COMMIT) {
    console.log('\n── Verification ' + '─'.repeat(44));
    const stillNoCountry = await db.collection('products').countDocuments(noCountry);
    const stillNoCode = await db.collection('users').countDocuments({ $or: [{ referralCode: { $exists: false } }, { referralCode: null }, { referralCode: '' }] });
    const withCode = await db.collection('users').countDocuments({ referralCode: { $nin: [null, ''] } });
    const distinct = (await db.collection('users').distinct('referralCode', { referralCode: { $nin: [null, ''] } })).length;
    const tableRows = await db.collection('referralcodes').countDocuments();
    const withCount = await db.collection('users').countDocuments({ purchaseCount: { $gt: 0 } });

    /* Did any generated code land on a reserved one? This is the check the
       stock backfill script cannot make, and the whole reason for this one. */
    const poolCodes = (await db.collection('specialreferralcodes').find({}, { projection: { code: 1 } }).toArray()).map((c) => String(c.code).toUpperCase());
    const clash = await db.collection('users').countDocuments({ referralCode: { $in: poolCodes } });

    console.log('  products still without country: ' + stillNoCountry + (stillNoCountry === 0 ? '  ok' : '  BAD'));
    console.log('  users still without a code:     ' + stillNoCode + (stillNoCode === 0 ? '  ok' : '  BAD'));
    console.log('  user codes unique:              ' + (distinct === withCode ? 'yes  ok' : 'NO — ' + withCode + ' users / ' + distinct + ' distinct  BAD'));
    console.log('  referralcodes table rows:       ' + tableRows);
    console.log('  users with purchaseCount > 0:   ' + withCount);
    console.log('  codes clashing with pool:       ' + clash + (clash === 0 ? '  ok' : '  BAD — a reserved code was given away'));
    process.exitCode = (stillNoCountry === 0 && stillNoCode === 0 && distinct === withCode && clash === 0) ? 0 : 1;
  } else {
    console.log('\nDry run only. Re-run with --commit to apply.');
  }

  await client.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
