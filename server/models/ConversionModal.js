const mongoose = require('mongoose');

const conversionSchema = new mongoose.Schema({
  user:             { type: mongoose.Schema.Types.ObjectId, ref: 'user', required: true },
  usdtAmount:       { type: Number, required: true },
  nairaAmount:      { type: Number, required: true },
  finalRate:        { type: Number, required: true },
  lowestRate:       { type: Number, default: 0 },
  providerARate:    { type: Number, default: 0 },
  providerBRate:    { type: Number, default: 0 },
  providerCRate:    { type: Number, default: 0 },
  conversionMarkup: { type: Number, default: 0 },
  rateSpread:       { type: Number, default: 0 },
  status: {
    type: String,
    enum: ['COMPLETED', 'FAILED'],
    default: 'COMPLETED',
  },

  // Naira-side wallet balance either side of the conversion. A conversion
  // moves real money (USDT out, NAIRA in) but never produced a statement row
  // before, so it now carries the same snapshots as every other entry.
  balanceBefore: { type: Number, default: null },
  balanceAfter:  { type: Number, default: null },

  // USDT side, for completeness on the statement.
  usdtBalanceBefore: { type: Number, default: null },
  usdtBalanceAfter:  { type: Number, default: null },

  balanceSource: { type: String, enum: ['live', 'backfill', null], default: null },
}, { timestamps: true });

conversionSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model('Conversion', conversionSchema);
