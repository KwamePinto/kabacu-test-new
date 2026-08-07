const mongoose = require('mongoose');

const walletSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
   balances: {
    BTT: {
      type: Number,
      default: 0
    },
    RP: {
      type: Number,
      default: 0
    },
     USDT: {
      type: Number,
      default: 0
    },
     NAIRA: {
      type: Number,
      default: 0
    },
  }
}, { timestamps: true });

walletSchema.index({ user: 1 }, { unique: true });

module.exports = mongoose.model('Wallet', walletSchema);