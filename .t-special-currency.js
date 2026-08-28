/* Verifies special-code purchases debit the right flat wallet currency
 * (BTT/USDT), while custom codes are untouched (still market-priced), and that
 * a code's own price+currency override the settings default correctly.
 *
 * Runs against a scratch database derived from MONGO_URI, never live.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const base = process.env.MONGO_URI;
if (!base || /genjpyi/.test(base)) { console.log('bad or live URI'); process.exit(1); }
const URI = base.replace(/\/([^/?]+)(\?|$)/, '/t_special_currency$2');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

(async () => {
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 20000 });
  if (!/t_special_currency/.test(mongoose.connection.name)) { console.log('wrong db'); process.exit(1); }
  for (const c of await mongoose.connection.db.listCollections().toArray()) {
    await mongoose.connection.db.collection(c.name).drop();
  }

  const User = require('./server/models/UserModel');
  const Wallet = require('./server/models/WalletModal');
  const ReferralSettings = require('./server/models/ReferralSettingsModel');
  const SpecialCode = require('./server/models/SpecialReferralCodeModel');
  const ReferralCodeRequest = require('./server/models/ReferralCodeRequestModel');
  const ReferralCode = require('./server/models/ReferralCodeModel');
  const svc = require('./server/services/referralCodeService');

  const settings = await ReferralSettings.getSettings();
  settings.paidCodes = {
    isActive: true,
    autoApprove: false,
    special: { price: 5, currency: 'USDT', rewardBonusPercent: 20, commissionBonusPercent: 0 },
    custom: { price: 100, rewardBonusPercent: 0, commissionBonusPercent: 0, minLength: 4, maxLength: 16 },
  };
  await settings.save();

  async function makeUser(n) {
    const u = await User.create({
      username: 'zz' + n, email: 'zz' + n + '@example.com', password: 'x',
      referralCode: 'ZZBASE' + n, walletCountry: 'NG', role: 'users',
    });
    await Wallet.create({ user: u._id, balances: { NAIRA: 1000, RP: 0, BTT: 50, USDT: 3 } });
    return u;
  }

  console.log('── settings-priced special code, debits USDT ──');
  const alice = await makeUser(1);
  const codeA = await SpecialCode.create({ code: 'ALICECODE', price: 0, note: '' }); // uses settings default

  // Advisory check should refuse: alice only has 3 USDT, code costs 5.
  const reqFail = await svc.requestCode(alice._id, { type: 'special', specialId: codeA._id });
  ok('insufficient USDT is refused at request time',
     reqFail.success === false && /USDT/.test(reqFail.message), JSON.stringify(reqFail));

  // Top her up and retry.
  await Wallet.updateOne({ user: alice._id }, { $set: { 'balances.USDT': 10 } });
  const reqOk = await svc.requestCode(alice._id, { type: 'special', specialId: codeA._id });
  ok('request succeeds once funded', reqOk.success === true, JSON.stringify(reqOk));
  ok('request records currency USDT', reqOk.currency === 'USDT', reqOk.currency);

  const pending = await ReferralCodeRequest.findOne({ user: alice._id, status: 'pending' }).lean();
  ok('pending request stored currency=USDT and price=5', pending.currency === 'USDT' && pending.price === 5);

  const beforeApprove = await Wallet.findOne({ user: alice._id }).lean();
  ok('nothing charged yet before approval', beforeApprove.balances.USDT === 10, beforeApprove.balances.USDT);

  const approved = await svc.approveRequest(pending._id, { reviewer: 'test' });
  ok('approval succeeds', approved.success === true, JSON.stringify(approved));

  const afterApprove = await Wallet.findOne({ user: alice._id }).lean();
  ok('USDT debited by exactly the price', afterApprove.balances.USDT === 5,
     'expected 5, got ' + afterApprove.balances.USDT);
  ok('BTT untouched', afterApprove.balances.BTT === 50, afterApprove.balances.BTT);
  ok('NAIRA untouched', afterApprove.balances.NAIRA === 1000, afterApprove.balances.NAIRA);

  const settledReq = await ReferralCodeRequest.findById(pending._id).lean();
  ok('balanceBefore/After recorded against the USDT balance',
     settledReq.balanceBefore === 10 && settledReq.balanceAfter === 5,
     JSON.stringify({ before: settledReq.balanceBefore, after: settledReq.balanceAfter }));

  const issued = await ReferralCode.findOne({ user: alice._id, isPrimary: true }).lean();
  ok('code issued with the reward bonus frozen from settings',
     issued && issued.code === 'ALICECODE' && issued.rewardBonusPercent === 20,
     JSON.stringify(issued));

  console.log('\n── code with its own price+currency overrides settings ──');
  const bob = await makeUser(2);
  const codeB = await SpecialCode.create({ code: 'BOBCODE', price: 7, currency: 'BTT', note: '' });

  const reqB = await svc.requestCode(bob._id, { type: 'special', specialId: codeB._id });
  ok('own-priced code request succeeds (BTT, has 50)', reqB.success === true, JSON.stringify(reqB));
  ok('uses the code\'s own currency, not the settings default', reqB.currency === 'BTT', reqB.currency);

  const pendingB = await ReferralCodeRequest.findOne({ user: bob._id, status: 'pending' }).lean();
  ok('own price (7) used, not the settings default (5)', pendingB.price === 7, pendingB.price);

  await svc.approveRequest(pendingB._id, { reviewer: 'test' });
  const bobWallet = await Wallet.findOne({ user: bob._id }).lean();
  ok('BTT debited by 7', bobWallet.balances.BTT === 43, bobWallet.balances.BTT);
  ok('USDT untouched for bob', bobWallet.balances.USDT === 3, bobWallet.balances.USDT);

  console.log('\n── custom code still debits the market wallet, unaffected ──');
  const carol = await makeUser(3);
  const reqC = await svc.requestCode(carol._id, { type: 'custom', code: 'CAROLPICK' });
  ok('custom request succeeds (NAIRA 1000 >= 100)', reqC.success === true, JSON.stringify(reqC));
  ok('custom request carries no currency (market-priced)', reqC.currency == null, String(reqC.currency));

  const pendingC = await ReferralCodeRequest.findOne({ user: carol._id, status: 'pending' }).lean();
  ok('custom request stored with currency null', pendingC.currency === null || pendingC.currency === undefined);

  await svc.approveRequest(pendingC._id, { reviewer: 'test' });
  const carolWallet = await Wallet.findOne({ user: carol._id }).lean();
  ok('NAIRA debited for the custom code', carolWallet.balances.NAIRA === 900, carolWallet.balances.NAIRA);
  ok('carol\'s BTT/USDT untouched', carolWallet.balances.BTT === 50 && carolWallet.balances.USDT === 3);

  console.log('\n── double-approval cannot double-charge ──');
  const dave = await makeUser(4);
  await Wallet.updateOne({ user: dave._id }, { $set: { 'balances.USDT': 10 } });
  const codeD = await SpecialCode.create({ code: 'DAVECODE', price: 0, note: '' });
  const reqD = await svc.requestCode(dave._id, { type: 'special', specialId: codeD._id });
  ok('daves request to queue for the race succeeds', reqD.success === true, JSON.stringify(reqD));
  const pendingD = await ReferralCodeRequest.findOne({ user: dave._id, status: 'pending' }).lean();

  const [firstTry, secondTry] = await Promise.all([
    svc.approveRequest(pendingD._id, { reviewer: 'racer-a' }),
    svc.approveRequest(pendingD._id, { reviewer: 'racer-b' }),
  ]);
  const oneWon = [firstTry.success, secondTry.success].filter(Boolean).length === 1;
  ok('exactly one concurrent approval wins', oneWon, JSON.stringify({ firstTry, secondTry }));

  const daveWallet = await Wallet.findOne({ user: dave._id }).lean();
  ok('dave charged exactly once (10 - 5 = 5)', daveWallet.balances.USDT === 5, daveWallet.balances.USDT);

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('ERR ' + e.stack); process.exit(1); });
