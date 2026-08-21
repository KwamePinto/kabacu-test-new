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

  // ── Signup bonus ──────────────────────────────────────────────────────────
  // A promotion the admin can switch on and off at will. It applies to EVERY
  // new user, not only those who arrived via a referral code.
  //
  // Paid at email verification rather than at signup: signing up is free and
  // unlimited, so crediting before verification lets one person farm the bonus
  // with throwaway addresses. Requiring a working inbox puts a real cost on it.
  signupBonus: {
    isActive: { type: Boolean, default: false },

    // Data is deliberately not offered here — granting a bundle needs a
    // destination phone number, which a brand-new account has not given yet.
    rewardType: { type: String, enum: ['money', 'rewardpoint'], default: 'rewardpoint' },

    amount: { type: Number, default: 0, min: 0 },
  },

  // ── Ongoing referral commission ───────────────────────────────────────────
  // Once a referred user has qualified (met the threshold and paid out the
  // one-off reward), EVERY subsequent purchase they make earns their referrer
  // a percentage.
  //
  // Crucially this is a GIFT, never a deduction. The referred user is charged
  // the full amount and receives their full RP; the commission is credited to
  // the referrer on top. Taking it out of the purchase would distort revenue
  // and profit reporting, so it is accounted for as a separate reward.
  referralCommission: {
    isActive: { type: Boolean, default: false },

    // cashback  -> percent of the purchase value, paid into the NAIRA wallet
    // rewardpoint -> percent of the RP the referred user earned, paid as RP
    type: { type: String, enum: ['cashback', 'rewardpoint'], default: 'cashback' },

    percent: { type: Number, default: 0, min: 0, max: 100 },

    // Lifetime ceiling on what a single referred user can ever generate for
    // their referrer. 0 = unlimited. Keeps an open-ended liability bounded.
    maxPerReferredUser: { type: Number, default: 0, min: 0 },
  },
}, { timestamps: true });

/** Always returns the single settings document, creating it on first use. */
referralSettingsSchema.statics.getSettings = async function () {
  let doc = await this.findOne();
  if (!doc) doc = await this.create({});
  return doc;
};

module.exports = mongoose.model('ReferralSettings', referralSettingsSchema);
