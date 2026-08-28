/* Verifies the one-off referral reward correctly credits BTT/USDT wallet
 * balances (replacing the old money/data types), and that rewardpoint still
 * works unchanged. Driven entirely through the public service functions
 * (applyReferralCode + handlePurchase) — the real flow, not an internal.
 * Runs against a scratch database, never live.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const base = process.env.MONGO_URI;
if (!base || /genjpyi/.test(base)) { console.log('bad or live URI'); process.exit(1); }
const URI = base.replace(/\/([^/?]+)(\?|$)/, '/t_reward_type$2');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

(async () => {
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 20000 });
  if (!/t_reward_type/.test(mongoose.connection.name)) { console.log('wrong db'); process.exit(1); }
  for (const c of await mongoose.connection.db.listCollections().toArray()) {
    await mongoose.connection.db.collection(c.name).drop();
  }

  const User = require('./server/models/UserModel');
  const Wallet = require('./server/models/WalletModal');
  const Referral = require('./server/models/ReferralModel');
  const ReferralSettings = require('./server/models/ReferralSettingsModel');
  const svc = require('./server/services/referralService');

  async function makeUser(n) {
    const u = await User.create({
      username: 'zzr' + n, email: 'zzr' + n + '@example.com', password: 'x', role: 'users',
    });
    await Wallet.create({ user: u._id, balances: { NAIRA: 0, RP: 0, BTT: 0, USDT: 0 } });
    return u;
  }

  const settings = await ReferralSettings.getSettings();
  ok('the old money/data values are no longer legal on the schema',
     settings.schema.path('rewardType').enumValues.indexOf('money') === -1
     && settings.schema.path('rewardType').enumValues.indexOf('data') === -1,
     JSON.stringify(settings.schema.path('rewardType').enumValues));

  async function fullFlow(label, opts) {
    // Referrer created first so the "referrer must be older" rule is satisfied.
    const referrer = await makeUser(label + 'A');
    const referred = await makeUser(label + 'B');
    await User.updateOne({ _id: referrer._id }, { $set: { referralCode: 'REF' + label } });

    settings.rewardType = opts.rewardType;
    settings.amount = opts.amount;
    settings.minPurchaseAmount = 0;
    await settings.save();

    const applied = await svc.applyReferralCode(referred._id, 'REF' + label);
    if (!applied.success) return { applied, referrer, referred };

    await svc.handlePurchase(referred._id, { amount: 500 });
    const referral = await Referral.findOne({ referred: referred._id }).lean();
    const wallet = await Wallet.findOne({ user: referrer._id }).lean();
    const referrerUser = await User.findById(referrer._id).lean();
    return { applied, referral, wallet, referrerUser, referrer, referred };
  }

  console.log('── BTT reward, end to end ──');
  const r1 = await fullFlow('B1', { rewardType: 'BTT', amount: 10 });
  ok('code applies', r1.applied.success, JSON.stringify(r1.applied));
  ok('referral settles as rewarded', r1.referral.status === 'rewarded', r1.referral.status);
  ok('snapshot records rewardType BTT', r1.referral.rewardType === 'BTT', r1.referral.rewardType);
  ok('snapshot records amount 10', r1.referral.rewardAmount === 10, r1.referral.rewardAmount);
  ok('BTT wallet actually credited by 10', r1.wallet.balances.BTT === 10, r1.wallet.balances.BTT);
  ok('USDT/NAIRA/RP untouched', r1.wallet.balances.USDT === 0 && r1.wallet.balances.NAIRA === 0 && r1.wallet.balances.RP === 0);

  console.log('\n── USDT reward, end to end ──');
  const r2 = await fullFlow('U1', { rewardType: 'USDT', amount: 5 });
  ok('code applies', r2.applied.success, JSON.stringify(r2.applied));
  ok('referral settles as rewarded', r2.referral.status === 'rewarded');
  ok('snapshot records rewardType USDT', r2.referral.rewardType === 'USDT', r2.referral.rewardType);
  ok('USDT wallet credited by 5', r2.wallet.balances.USDT === 5, r2.wallet.balances.USDT);
  ok('BTT untouched for this referrer', r2.wallet.balances.BTT === 0, r2.wallet.balances.BTT);

  console.log('\n── rewardpoint unchanged ──');
  const r3 = await fullFlow('R1', { rewardType: 'rewardpoint', amount: 100 });
  ok('code applies', r3.applied.success, JSON.stringify(r3.applied));
  ok('referral settles as rewarded', r3.referral.status === 'rewarded');
  ok('snapshot records rewardType rewardpoint', r3.referral.rewardType === 'rewardpoint');
  ok('rpBalance credited by 100', r3.referrerUser.rpBalance === 100, r3.referrerUser.rpBalance);
  ok('no wallet balance touched for a rewardpoint payout',
     r3.wallet.balances.BTT === 0 && r3.wallet.balances.USDT === 0 && r3.wallet.balances.NAIRA === 0);

  console.log('\n── a code bonus still uplifts a BTT payout ──');
  const referrer4 = await makeUser('X1A');
  const referred4 = await makeUser('X1B');
  await User.updateOne({ _id: referrer4._id }, { $set: { referralCode: 'REFX1' } });

  const ReferralCode = require('./server/models/ReferralCodeModel');
  // Retire the plain code and issue a bonused one in its place, the way a paid
  // code actually gets attached to an account.
  await ReferralCode.deleteMany({ user: referrer4._id });
  await ReferralCode.create({
    user: referrer4._id, code: 'REFX1', kind: 'special', isPrimary: true, rewardBonusPercent: 20,
  });

  settings.rewardType = 'BTT';
  settings.amount = 5;
  await settings.save();

  await svc.applyReferralCode(referred4._id, 'REFX1');
  await svc.handlePurchase(referred4._id, { amount: 500 });

  const w4 = await Wallet.findOne({ user: referrer4._id }).lean();
  ok('20% code bonus applied: 5 * 1.2 = 6', w4.balances.BTT === 6, w4.balances.BTT);

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('ERR ' + e.stack); process.exit(1); });
