/**
 * Tags every existing product with a market country.
 *
 *   node scripts/backfill-product-country.js          # report only
 *   node scripts/backfill-product-country.js --apply  # write
 *
 * Everything currently in the catalogue is Nigerian, so all existing rows are
 * set to NG. Safe to re-run: products that already have a country are skipped.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Product  = require('../server/models/ProductsModal');

const APPLY  = process.argv.includes('--apply');
const TARGET = 'NG';

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('connected\n');

  const filter = { $or: [{ country: { $exists: false } }, { country: null }, { country: '' }] };

  const total   = await Product.countDocuments();
  const missing = await Product.countDocuments(filter);

  console.log(`products total:     ${total}`);
  console.log(`without a country:  ${missing}`);
  console.log(`already tagged:     ${total - missing}\n`);

  if (!APPLY) {
    console.log(`REPORT ONLY — re-run with --apply to set them all to ${TARGET}.`);
    await mongoose.disconnect();
    return;
  }

  const res = await Product.updateMany(filter, { $set: { country: TARGET } });
  console.log(`tagged ${res.modifiedCount} products as ${TARGET}`);

  const byCountry = await Product.aggregate([
    { $group: { _id: { country: '$country', category: '$category' }, n: { $sum: 1 } } },
    { $sort: { n: -1 } },
  ]);
  console.log('\nresulting distribution:');
  byCountry.forEach(r => console.log(`  ${r._id.country || '(none)'}  ${r._id.category}  ${r.n}`));

  const stillMissing = await Product.countDocuments(filter);
  console.log(`\nstill untagged: ${stillMissing}`);

  await mongoose.disconnect();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
