#!/usr/bin/env node
/**
 * Bring the existing single-market setup onto the country-wallet model.
 *
 * Everything the platform had before country wallets was implicitly Nigerian,
 * so this makes that explicit rather than changing behaviour:
 *
 *   1. create the Nigeria wallet, currency copied from the lookup table
 *   2. stamp country=NG on every payment method that has none
 *   3. mark the PalmPay method as a hosted checkout, since it is the one
 *      integration actually wired up — everything else defaults to manual
 *   4. stamp country=NG on every product that has none
 *
 * Idempotent: safe to run more than once, and it reports what it would change
 * before touching anything. Pass --dry to stop after the report.
 *
 *   node scripts/seed-country-wallets.js --dry
 *   node scripts/seed-country-wallets.js
 */

require('dotenv').config();
const mongoose = require('mongoose');

const { toCode, toName, currencyFor, DEFAULT_COUNTRY } = require('../server/utils/country');

const DRY = process.argv.includes('--dry');

(async () => {
  const uri = (process.env.MONGO_URI || '').trim();
  if (!uri) {
    console.error('MONGO_URI is not set.');
    process.exit(1);
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 30000 });
  console.log(`connected to ${mongoose.connection.name}${DRY ? '  (dry run)' : ''}\n`);

  const CountryWallet = require('../server/models/CountryWalletModel');
  const PaymentMethod = require('../server/models/PaymentMethodModel');
  const Product = require('../server/models/ProductsModal');

  const ngCurrency = currencyFor(DEFAULT_COUNTRY);

  /* ── 1. the Nigeria wallet ─────────────────────────────────────────────── */
  const existing = await CountryWallet.findOne({ country: DEFAULT_COUNTRY });
  if (existing) {
    console.log(`1. Nigeria wallet already exists (${existing.currencySymbol} ${existing.currencyCode}) — left alone`);
  } else if (DRY) {
    console.log(`1. would create the Nigeria wallet (${ngCurrency.symbol} ${ngCurrency.code})`);
  } else {
    await CountryWallet.create({
      country: DEFAULT_COUNTRY,
      currencyCode: ngCurrency.code,
      currencySymbol: ngCurrency.symbol,
      currencyName: ngCurrency.name,
      isActive: true,
      createdBy: 'seed-country-wallets',
    });
    console.log(`1. created the Nigeria wallet (${ngCurrency.symbol} ${ngCurrency.code})`);
  }

  /* ── 2. existing payment methods are Nigerian ──────────────────────────── */
  // `country` did not exist on these documents, so match on missing OR empty
  // rather than trusting the schema default to have been applied on read.
  const unstamped = await PaymentMethod.countDocuments({
    $or: [{ country: { $exists: false } }, { country: null }, { country: '' }],
  });
  if (!unstamped) {
    console.log('2. every payment method already has a country — nothing to stamp');
  } else if (DRY) {
    console.log(`2. would stamp country=NG on ${unstamped} payment method(s)`);
  } else {
    const r = await PaymentMethod.updateMany(
      { $or: [{ country: { $exists: false } }, { country: null }, { country: '' }] },
      { $set: { country: DEFAULT_COUNTRY } },
    );
    console.log(`2. stamped country=NG on ${r.modifiedCount} payment method(s)`);
  }

  /* ── 3. PalmPay is the one real gateway ────────────────────────────────── */
  // Every other method defaults to manual, which is correct: they have no
  // integration behind them, so an admin confirms those top-ups by hand.
  const palm = await PaymentMethod.find({ name: /palm\s*pay/i });
  if (!palm.length) {
    console.log('3. no PalmPay method found — nothing to mark as a gateway');
  } else if (DRY) {
    console.log(`3. would mark ${palm.length} PalmPay method(s) as a hosted checkout`);
  } else {
    for (const m of palm) {
      m.kind = 'gateway';
      m.provider = m.provider || 'palmpay';
      await m.save();
    }
    console.log(`3. marked ${palm.length} PalmPay method(s) as a hosted checkout`);
  }

  /* ── 4. products with no market are Nigerian ───────────────────────────── */
  const untagged = await Product.countDocuments({
    $or: [{ country: { $exists: false } }, { country: null }, { country: '' }],
  });
  if (!untagged) {
    console.log('4. every product already has a country — nothing to stamp');
  } else if (DRY) {
    console.log(`4. would stamp country=NG on ${untagged} product(s)`);
  } else {
    const r = await Product.updateMany(
      { $or: [{ country: { $exists: false } }, { country: null }, { country: '' }] },
      { $set: { country: DEFAULT_COUNTRY } },
    );
    console.log(`4. stamped country=NG on ${r.modifiedCount} product(s)`);
  }

  /* ── where things stand ────────────────────────────────────────────────── */
  console.log('\n— current state —');
  const wallets = await CountryWallet.find().sort({ country: 1 }).lean();
  for (const w of wallets) {
    const methods = await PaymentMethod.countDocuments({ country: w.country, isActive: true });
    const products = await Product.countDocuments({ country: w.country, is_deleted: { $ne: 1 } });
    console.log(
      `  ${w.country} ${toName(w.country)}: ${w.currencySymbol} ${w.currencyCode}` +
      `, ${methods} active method(s), ${products} product(s)` +
      `${w.isActive ? '' : '  [hidden]'}`,
    );
  }

  // Products sitting in a market with no wallet can be browsed and not bought.
  const byCountry = await Product.aggregate([
    { $match: { is_deleted: { $ne: 1 } } },
    { $group: { _id: '$country', n: { $sum: 1 } } },
  ]);
  const walletCodes = new Set(wallets.map(w => w.country));
  const orphans = byCountry.filter(r => !walletCodes.has(toCode(r._id) || DEFAULT_COUNTRY));
  if (orphans.length) {
    console.log('\n  products in markets with NO wallet (browsable, not buyable):');
    orphans.forEach(o => console.log(`    ${o._id || '(none)'}: ${o.n}`));
  }

  await mongoose.disconnect();
  console.log(DRY ? '\ndry run — nothing was written' : '\ndone');
})().catch(err => {
  console.error('failed:', err.message);
  process.exit(1);
});
