require('dotenv').config();
const mongoose = require('mongoose');
const Product  = require('../server/models/ProductsModal');

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('DB connected');

  // Find all soft-deleted DATA products to identify the right one
  const deleted = await Product.find({ category: 'DATA', is_deleted: 1 }).lean();

  if (deleted.length === 0) {
    console.log('No deleted DATA products found.');
    process.exit(0);
  }

  console.log(`\nFound ${deleted.length} deleted DATA product(s):\n`);
  deleted.forEach((p, i) => {
    console.log(`[${i}] ID: ${p._id}`);
    console.log(`     plan_type:       ${p.dataDetails?.plan_type}`);
    console.log(`     plan_name:       ${p.dataDetails?.plan_name}`);
    console.log(`     network:         ${p.dataDetails?.network}`);
    console.log(`     amount:          ${p.dataDetails?.amount}`);
    console.log(`     validate_period: ${p.dataDetails?.validate_period}`);
    console.log(`     plan_id:         ${p.dataDetails?.plan_id}`);
    console.log('');
  });

  process.exit(0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
