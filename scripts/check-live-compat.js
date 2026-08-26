/* READ-ONLY compatibility audit of the LIVE database against KabakuNew's code.
 *
 * Answers one question: if MONGO_URI were pointed at live right now, what would
 * break? Every operation here is a read or a count. Nothing is written, and the
 * script refuses to run against anything that is not the live cluster so it
 * cannot be pointed somewhere unexpected by accident.
 */
require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');

// Pull the commented-out live URI straight from .env rather than pasting a
// credential into a file.
const envRaw = fs.readFileSync('.env', 'utf8');
const liveLine = envRaw.split(/\r?\n/).find((l) => /^##MONGO_URI/.test(l) && /genjpyi/.test(l));
if (!liveLine) { console.log('Could not find the live URI in .env'); process.exit(1); }
const LIVE_URI = liveLine.replace(/^##MONGO_URI\s*=\s*/, '').trim();

if (!/genjpyi/.test(LIVE_URI)) { console.log('REFUSING: that is not the live cluster'); process.exit(1); }

(async () => {
  await mongoose.connect(LIVE_URI, { serverSelectionTimeoutMS: 30000 });
  console.log('  connected READ-ONLY to:', mongoose.connection.name, '(live)\n');

  const db = mongoose.connection.db;
  const findings = [];

  const collections = (await db.listCollections().toArray()).map((c) => c.name);
  const has = (n) => collections.includes(n);

  /* ── 1. Products must carry `country` or the store filter hides them ───── */
  const products = db.collection('products');
  const pTotal = await products.countDocuments({});
  const pNoCountry = await products.countDocuments({
    $or: [{ country: { $exists: false } }, { country: null }, { country: '' }],
  });
  console.log('  products: ' + pTotal + ' total, ' + pNoCountry + ' with no country');
  if (pNoCountry > 0) {
    findings.push({
      sev: 'BREAKING',
      what: pNoCountry + ' of ' + pTotal + ' products have no `country` field',
      effect: 'countryFilter queries {country:"NG"}, which does NOT match missing fields — those products vanish from the store for every user',
      fix: 'node scripts/backfill-product-country.js',
    });
  }

  /* ── 2. Payment methods need `country` or nobody can top up ───────────── */
  if (has('paymentmethods')) {
    const pm = db.collection('paymentmethods');
    const mTotal = await pm.countDocuments({});
    const mNoCountry = await pm.countDocuments({
      $or: [{ country: { $exists: false } }, { country: null }, { country: '' }],
    });
    console.log('  paymentmethods: ' + mTotal + ' total, ' + mNoCountry + ' with no country');
    if (mNoCountry > 0) {
      findings.push({
        sev: 'BREAKING',
        what: mNoCountry + ' of ' + mTotal + ' payment methods have no `country`',
        effect: 'the wallet page queries methods by country, so the funding dropdown comes up empty and users cannot top up',
        fix: 'node scripts/seed-country-wallets.js',
      });
    }
  } else {
    console.log('  paymentmethods: collection does not exist');
    findings.push({
      sev: 'WARN',
      what: 'no paymentmethods collection',
      effect: 'funding dropdown will be empty until methods are created',
      fix: 'create them in Admin -> Payments & Wallets',
    });
  }

  /* ── 3. A country wallet must exist or balances lose their currency ────── */
  if (has('countrywallets')) {
    const cw = db.collection('countrywallets');
    const cwCount = await cw.countDocuments({});
    const ng = await cw.findOne({ country: 'NG' });
    console.log('  countrywallets: ' + cwCount + ' total, NG present: ' + !!ng);
    if (!ng) {
      findings.push({
        sev: 'BREAKING',
        what: 'no Nigeria country wallet',
        effect: 'activeCurrency resolves empty, so wallet balances render with no currency symbol and the market is not "live"',
        fix: 'node scripts/seed-country-wallets.js',
      });
    }
  } else {
    console.log('  countrywallets: collection does not exist');
    findings.push({
      sev: 'BREAKING',
      what: 'countrywallets collection missing entirely',
      effect: 'no market is live: wallet switcher empty, balances unlabelled, purchases blocked by the market guard',
      fix: 'node scripts/seed-country-wallets.js',
    });
  }

  /* ── 4. Referral codes: the table is the new lookup ───────────────────── */
  const users = db.collection('users');
  const uTotal = await users.countDocuments({});
  const uWithCode = await users.countDocuments({ referralCode: { $exists: true, $nin: [null, ''] } });
  const rcCount = has('referralcodes') ? await db.collection('referralcodes').countDocuments({}) : 0;
  console.log('  users: ' + uTotal + ' total, ' + uWithCode + ' holding a referralCode');
  console.log('  referralcodes rows: ' + rcCount);
  if (uWithCode > rcCount) {
    findings.push({
      sev: 'DEGRADED',
      what: (uWithCode - rcCount) + ' held codes have no row in `referralcodes`',
      effect: 'applyReferralCode falls back to User.referralCode so codes still resolve, but retired codes cannot exist and the history panel is empty',
      fix: 'node scripts/backfill-referral-code-table.js',
    });
  }

  /* ── 5. walletCountry on users ─────────────────────────────────────────── */
  const uNoWalletCountry = await users.countDocuments({
    $or: [{ walletCountry: { $exists: false } }, { walletCountry: null }, { walletCountry: '' }],
  });
  console.log('  users with no walletCountry: ' + uNoWalletCountry);
  if (uNoWalletCountry > 0) {
    findings.push({
      sev: 'OK-BY-DESIGN',
      what: uNoWalletCountry + ' users have no `walletCountry`',
      effect: 'none — marketOf() treats a missing value as Nigeria, so they default correctly with no migration',
      fix: 'nothing required',
    });
  }

  /* ── 6. Admin 2FA is on by default ────────────────────────────────────── */
  if (has('useradmins')) {
    const ua = db.collection('useradmins');
    const aTotal = await ua.countDocuments({});
    const aNo2fa = await ua.countDocuments({
      $or: [{ twoFactorEnabled: { $exists: false } }, { twoFactorEnabled: null }],
    });
    console.log('  admins: ' + aTotal + ' total, ' + aNo2fa + ' without an explicit twoFactorEnabled');
    if (aNo2fa > 0) {
      findings.push({
        sev: 'BEHAVIOUR CHANGE',
        what: aNo2fa + ' admin(s) have no twoFactorEnabled field',
        effect: 'the schema default is true, so every admin will be asked for an emailed OTP at next login — works, but it is new behaviour and depends on SES delivering',
        fix: 'intended; a super admin can switch it off per admin if needed',
      });
    }
  }

  /* ── 7. Balance-chain fields Old added ────────────────────────────────── */
  const tx = db.collection('transactions');
  const txTotal = await tx.countDocuments({});
  const txNoBalance = await tx.countDocuments({
    paymentMethod: 'wallet',
    $or: [{ balanceBefore: { $exists: false } }, { balanceBefore: null }],
  });
  console.log('  transactions: ' + txTotal + ' total, ' + txNoBalance + ' wallet txns with no balanceBefore');
  if (txNoBalance > 0) {
    findings.push({
      sev: 'COSMETIC',
      what: txNoBalance + ' wallet transactions have no balance chain',
      effect: 'those statement rows show an amount with no before/after; new ones record it going forward',
      fix: 'node scripts/backfill-statement-balances-v2.js (optional, historic only)',
    });
  }

  console.log('\n  ── verdict ──');
  const order = { 'BREAKING': 0, 'DEGRADED': 1, 'BEHAVIOUR CHANGE': 2, 'COSMETIC': 3, 'WARN': 4, 'OK-BY-DESIGN': 5 };
  findings.sort((a, b) => order[a.sev] - order[b.sev]);
  findings.forEach((f) => {
    console.log('\n  [' + f.sev + '] ' + f.what);
    console.log('     effect: ' + f.effect);
    console.log('     fix   : ' + f.fix);
  });
  if (!findings.length) console.log('  nothing to migrate — live data already matches the code');

  await mongoose.disconnect();
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });
