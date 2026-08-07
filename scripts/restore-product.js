require('dotenv').config();
const mongoose = require('mongoose');
const Product  = require('../server/models/ProductsModal');

const PRODUCT_ID = '6a7448cad0a6e4a10b830b0a';

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('DB connected');

  const product = await Product.findById(PRODUCT_ID);
  if (!product) {
    console.error('Product not found.');
    process.exit(1);
  }

  console.log(`Restoring: ${product.dataDetails?.plan_type} — ${product.dataDetails?.plan_name}`);

  product.is_deleted = 0;
  await product.save();

  console.log('Product restored successfully.');
  process.exit(0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
