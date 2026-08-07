require('dotenv').config();
const mongoose = require('mongoose');
const Transaction = require('../server/models/TransactionModel');
mongoose.connect(process.env.MONGO_URI).then(async () => {
  const count = await Transaction.countDocuments({
    paymentMethod: 'wallet',
    status: 'failed',
    'apiResponse.odsDelivered': true,
    'apiResponse.adminDeducted': { $ne: true },
    adminCleared: { $ne: true },
  });
  console.log('Transactions matching ODS_DAMAGE_FILTER:', count);
  process.exit(0);
});
