const mongoose = require('mongoose');

/**
 * Single-document configuration for what a referrer earns. Admins edit this
 * from Admin → Referrals.
 *
 * A reward of type `data` cannot simply be a number — it has to name an actual
 * data package to grant, which is why the admin picks one from the product
 * table rather than typing an amount.
 */
const referralSettingsSchema = new mongoose.Schema({
  isActive: { type: Boolean, default: true },

  rewardType: {
    type: String,
    enum: ['money', 'data', 'rewardpoint'],
    default: 'rewardpoint',
  },

  // Used by money (credited to the referrer's NAIRA wallet) and
  // rewardpoint (added to rpBalance). Ignored when rewardType is 'data'.
  amount: { type: Number, default: 0, min: 0 },

  // Required when rewardType is 'data' — the exact package to grant.
  dataProduct: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },

  // A referred user's first purchase must be at least this much to qualify.
  // 0 means any purchase qualifies.
  minPurchaseAmount: { type: Number, default: 0, min: 0 },

  // Safety valve: 0 = unlimited.
  maxRewardsPerReferrer: { type: Number, default: 0, min: 0 },
}, { timestamps: true });

/** Always returns the single settings document, creating it on first use. */
referralSettingsSchema.statics.getSettings = async function () {
  let doc = await this.findOne();
  if (!doc) doc = await this.create({});
  return doc;
};

module.exports = mongoose.model('ReferralSettings', referralSettingsSchema);
