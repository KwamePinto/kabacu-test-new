const mongoose = require('mongoose');

/**
 * One row per account link. This collection — not the user document — is the
 * authoritative record of who referred whom, and its unique index on
 * `referred` is what makes "a user can only ever use one referral code"
 * true at the database level rather than only in application code.
 *
 * Lifecycle:
 *   pending   link created, referred user has not purchased yet
 *   qualified referred user made their first purchase; reward is owed
 *   rewarded  reward has been paid to the referrer
 *   void      link was invalidated (e.g. reward could not be granted)
 */
const referralSchema = new mongoose.Schema({
  referrer: { type: mongoose.Schema.Types.ObjectId, ref: 'user', required: true },

  // Unique: enforces one-referrer-per-user at the storage layer.
  referred: { type: mongoose.Schema.Types.ObjectId, ref: 'user', required: true, unique: true },

  // The code as typed, kept for auditing even if the referrer later changes it.
  codeUsed: { type: String, required: true, uppercase: true, trim: true },

  status: {
    type: String,
    enum: ['pending', 'qualified', 'rewarded', 'void'],
    default: 'pending',
  },

  // The purchase that qualified this referral.
  qualifyingTransaction: { type: mongoose.Schema.Types.ObjectId, default: null },
  qualifiedAt: { type: Date, default: null },

  // Snapshot of the reward settings at payout time, so later changes to the
  // admin config never rewrite history.
  rewardType:    { type: String, enum: ['money', 'data', 'rewardpoint', null], default: null },
  rewardAmount:  { type: Number, default: 0 },
  rewardProduct: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
  rewardNote:    { type: String, default: '' },
  rewardedAt:    { type: Date, default: null },

  // ── Ongoing commission ────────────────────────────────────────────────────
  // Running total of what this one referred user has earned their referrer
  // from purchases made AFTER qualifying. Kept here rather than recomputed so
  // the per-referred-user cap can be enforced with a single read, and so the
  // history survives a change to the commission settings.
  commissionEarned: { type: Number, default: 0 },   // naira, or RP, per type
  commissionType:   { type: String, enum: ['cashback', 'rewardpoint', null], default: null },
  commissionCount:  { type: Number, default: 0 },   // how many payouts
  commissionLastAt: { type: Date, default: null },
}, { timestamps: true });

referralSchema.index({ referrer: 1, status: 1 });
referralSchema.index({ status: 1 });

module.exports = mongoose.model('Referral', referralSchema);
