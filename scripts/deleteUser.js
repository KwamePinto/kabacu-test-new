/**
 * Deletes a customer account and everything that references it.
 *
 *   node scripts/deleteUser.js someone@example.com              # dry run
 *   node scripts/deleteUser.js a@x.com b@y.com --commit         # actually delete
 *
 * Run it from the project root — dotenv resolves .env against the working
 * directory, so `cd scripts && node deleteUser.js` finds no MONGO_URI and
 * dies on connect.
 *
 * ── Why this is written the way it is ──────────────────────────────────────
 * An earlier version of this script looked correct and silently did almost
 * nothing. Every guard below exists because of a specific way that failed:
 *
 *   • It required '../server/models/WalletModel' and three more like it. The
 *     real files are WalletModal, CartModal, CheckoutModal, TopUpModal —
 *     "Modal", a typo that is now load-bearing. A safeRequire() helper turned
 *     each miss into a warning and carried on, so four collections were never
 *     touched and the run still reported success. Here the model map is built
 *     once, up front, and a missing model aborts before anything is deleted.
 *
 *   • It deleted Referral rows matching { referredUser: id }. That field does
 *     not exist — it is `referred` — so the filter matched nothing, every run.
 *     Field names are taken from the schemas now, and the row counts are read
 *     before and after so a no-op cannot look like a success.
 *
 *   • It "unlinked" referrals with { $set: { referrer: null } }. referrer is
 *     `required: true`, and updateMany skips validators, so that wrote rows
 *     the schema forbids — a referral belonging to nobody, which every reader
 *     of that collection then has to cope with. Rows are deleted outright
 *     here; a referral with no referrer is not history worth keeping.
 *
 *   • It ran with no idea whether the account held money. A balance check now
 *     stops the deletion unless --force is passed.
 *
 *   • It only ever looked at the User collection, so an admin account on the
 *     same address was invisible to it. Admin accounts live in UserAdmin and
 *     are NEVER touched here — deleting a customer must not cost someone
 *     their panel access — but the script says when one exists.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const COMMIT = process.argv.includes('--commit');
const FORCE = process.argv.includes('--force');
const EMAILS = process.argv.slice(2).filter((a) => !a.startsWith('--'));

/* Loaded eagerly and by exact filename. A typo is a crash on line one, not a
   collection quietly skipped halfway through a deletion. */
const User = require('../server/models/UserModel');
const UserAdmin = require('../server/models/UserAdminModel');
const Referral = require('../server/models/ReferralModel');

/* Everything that points at a user with a plain `user` field. Derived from
   the schemas — see the ref:'user' audit in the comment block above. */
const OWNED = {
  Wallet:              require('../server/models/WalletModal'),
  Cart:                require('../server/models/CartModal'),
  Checkout:            require('../server/models/CheckoutModal'),
  TopUp:               require('../server/models/TopUpModal'),
  Beneficiary:         require('../server/models/BeneficiaryModel'),
  Transaction:         require('../server/models/TransactionModel'),
  ReferralCode:        require('../server/models/ReferralCodeModel'),
  ReferralCodeRequest: require('../server/models/ReferralCodeRequestModel'),
  Conversion:          require('../server/models/ConversionModal'),
  CoursePurchase:      require('../server/models/CoursePurchaseModel'),
  UserDevice:          require('../server/models/UserDeviceModel'),
  UserNotification:    require('../server/models/UserNotificationModel'),
};

/* Two-sided: the user can be either party, so both directions must be cleared
   or the surviving side keeps a reference to a document that is gone. */
const Commission = require('../server/models/ReferralCommissionModel');
const SpecialCode = require('../server/models/SpecialReferralCodeModel');

async function main() {
  if (!EMAILS.length) {
    console.error('Usage: node scripts/deleteUser.js <email> [more emails] [--commit] [--force]');
    process.exit(1);
  }
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI is not set. Run this from the project root so .env is found.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
  console.log(COMMIT ? 'MODE: COMMIT — changes will be written\n' : 'MODE: DRY RUN — nothing will be written\n');

  /* Resolved up front so a referral between two targets is recognised as
     internal: clearing referredBy on an account that is itself about to go
     is pointless, and reporting it as an orphan would be misleading. */
  const targets = [];
  for (const email of EMAILS) {
    const u = await User.findOne({ email }).lean();
    if (!u) { console.log('SKIP ' + email + ' — no such user\n'); continue; }
    targets.push(u);
  }
  const targetIds = new Set(targets.map((t) => String(t._id)));
  if (!targets.length) { await mongoose.disconnect(); return; }

  let blocked = 0;

  for (const user of targets) {
    const id = user._id;
    console.log('='.repeat(68));
    console.log(user.email + '   ' + user.username + '   _id ' + id);
    console.log('='.repeat(68));

    /* ── Money guard ──────────────────────────────────────────────────── */
    const wallet = await OWNED.Wallet.findOne({ user: id }).lean();
    const balances = (wallet && wallet.balances) || {};
    const heldFlat = Object.entries(balances).filter(([, v]) => Number(v) > 0);
    const txCount = await OWNED.Transaction.countDocuments({ user: id });
    const holdings = [];
    if (Number(user.walletBalance) > 0) holdings.push('walletBalance=' + user.walletBalance);
    if (Number(user.rpBalance) > 0) holdings.push('rpBalance=' + user.rpBalance);
    heldFlat.forEach(([k, v]) => holdings.push('balances.' + k + '=' + v));
    if (txCount > 0) holdings.push(txCount + ' transaction(s)');

    if (holdings.length && !FORCE) {
      console.log('  BLOCKED — this account still holds value:');
      holdings.forEach((h) => console.log('    ' + h));
      console.log('  Settle it, or re-run with --force if you accept losing this record.\n');
      blocked++;
      continue;
    }
    if (holdings.length) {
      console.log('  WARNING (--force): deleting anyway despite ' + holdings.join(', '));
    } else {
      console.log('  money check: clean (no balances, no transactions)');
    }

    /* ── Admin account: reported, never touched ───────────────────────── */
    const admin = await UserAdmin.findOne({ email: user.email }).lean();
    console.log('  admin account on this address: ' +
      (admin ? admin.role + ', isActive=' + admin.isActive + ' — LEFT UNTOUCHED' : 'none'));

    /* ── Referrals ────────────────────────────────────────────────────── */
    const asReferrer = await Referral.find({ referrer: id }).lean();
    const asReferred = await Referral.find({ referred: id }).lean();
    for (const r of asReferrer) {
      const rewarded = r.status === 'rewarded';
      console.log('  referral they made: ' + r.status +
        (rewarded ? ' (reward ' + r.rewardAmount + ' ' + r.rewardType + ' already paid — row goes, payout stands)' : ''));
    }
    asReferred.forEach((r) => console.log('  referral that brought them in: ' + r.status));

    /* Downstream accounts keep pointing at a user that will not exist.
       Cleared — except where the downstream account is itself a target. */
    const downstream = await User.find({ referredBy: id }).select('email').lean();
    const outside = downstream.filter((d) => !targetIds.has(String(d._id)));
    if (downstream.length) {
      console.log('  accounts they referred: ' + downstream.length +
        ' (' + outside.length + ' outside this batch, referredBy will be cleared)');
      outside.forEach((d) => console.log('      ' + d.email));
    }

    if (!COMMIT) {
      const plan = {};
      for (const [name, model] of Object.entries(OWNED)) {
        const n = await model.countDocuments({ user: id });
        if (n) plan[name] = n;
      }
      const cR = await Commission.countDocuments({ referrer: id });
      const cD = await Commission.countDocuments({ referred: id });
      const sC = await SpecialCode.countDocuments({ permittedUser: id });
      if (cR) plan['Commission(referrer)'] = cR;
      if (cD) plan['Commission(referred)'] = cD;
      if (sC) plan['SpecialCode(release)'] = sC;
      if (asReferrer.length) plan['Referral(referrer)'] = asReferrer.length;
      if (asReferred.length) plan['Referral(referred)'] = asReferred.length;
      if (outside.length) plan['clear referredBy'] = outside.length;
      plan['User'] = 1;
      console.log('  would delete: ' + JSON.stringify(plan) + '\n');
      continue;
    }

    /* ── Delete ───────────────────────────────────────────────────────── */
    const done = {};
    for (const [name, model] of Object.entries(OWNED)) {
      const r = await model.deleteMany({ user: id });
      if (r.deletedCount) done[name] = r.deletedCount;
    }
    let n;
    n = (await Commission.deleteMany({ referrer: id })).deletedCount; if (n) done['Commission(referrer)'] = n;
    n = (await Commission.deleteMany({ referred: id })).deletedCount; if (n) done['Commission(referred)'] = n;
    n = (await Referral.deleteMany({ referrer: id })).deletedCount;   if (n) done['Referral(referrer)'] = n;
    n = (await Referral.deleteMany({ referred: id })).deletedCount;   if (n) done['Referral(referred)'] = n;

    /* A reserved code assigned to this user returns to the pool rather than
       being deleted — the code itself is inventory, not user data. */
    n = (await SpecialCode.updateMany(
      { permittedUser: id },
      { $set: { permittedUser: null, assignedAt: null } },
    )).modifiedCount;
    if (n) done['SpecialCode(released)'] = n;

    if (outside.length) {
      n = (await User.updateMany(
        { _id: { $in: outside.map((d) => d._id) } },
        { $set: { referredBy: null } },
      )).modifiedCount;
      if (n) done['clear referredBy'] = n;
    }

    done['User'] = (await User.deleteOne({ _id: id })).deletedCount;
    console.log('  deleted: ' + JSON.stringify(done));

    /* ── Verify, rather than trust the counts above ───────────────────── */
    const leftovers = [];
    if (await User.findById(id).lean()) leftovers.push('User');
    for (const [name, model] of Object.entries(OWNED)) {
      if (await model.countDocuments({ user: id })) leftovers.push(name);
    }
    for (const [name, q] of [
      ['Referral(referrer)', { referrer: id }], ['Referral(referred)', { referred: id }],
    ]) if (await Referral.countDocuments(q)) leftovers.push(name);
    for (const [name, q] of [
      ['Commission(referrer)', { referrer: id }], ['Commission(referred)', { referred: id }],
    ]) if (await Commission.countDocuments(q)) leftovers.push(name);
    if (await User.countDocuments({ referredBy: id })) leftovers.push('User.referredBy');

    console.log(leftovers.length
      ? '  VERIFY FAILED — still referencing this id: ' + leftovers.join(', ') + '\n'
      : '  verified: no document anywhere still references this id\n');
  }

  if (blocked) console.log(blocked + ' account(s) blocked by the money guard.');
  if (!COMMIT) console.log('Dry run only. Re-run with --commit to apply.');

  await mongoose.disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
