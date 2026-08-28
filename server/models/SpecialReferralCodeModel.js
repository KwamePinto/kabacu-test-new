const mongoose = require('mongoose');

/**
 * Premium / vanity referral codes, sold to users at a price.
 *
 * These are the "special numbers" pool: an admin reserves a memorable code
 * (VICTOR1, KABACU, 07000000 — any characters, any length) and sets what it
 * costs. Unlike system codes it does not follow the KB######## shape.
 *
 * ── Why a reserved pool rather than just writing the code onto a user ───────
 * A reserved code must be BLOCKED from the whole system until an admin
 * explicitly permits someone to have it. Keeping it here — and only copying it
 * onto User.referralCode at the moment it is assigned — means:
 *
 *   • nobody can apply it as a referral code while it is unassigned, because
 *     it isn't any user's code yet, so the existence check simply fails
 *   • the random generator can be told to avoid the pool, so a system code can
 *     never collide with something being held back for sale
 *
 * Admin-only for now: there is no client-facing purchase flow yet.
 */
const specialReferralCodeSchema = new mongoose.Schema({
  code: {
    type: String,
    required: true,
    unique: true,
    uppercase: true,
    trim: true,
  },

  // What the code sells for. 0 means free / promotional.
  price: { type: Number, default: 0, min: 0 },

  // What it is priced in. Null when price is 0 — a free code has no currency
  // to speak of — and required in practice whenever price is set, which the
  // admin form enforces.
  currency: { type: String, enum: ['BTT', 'USDT', null], default: null },

  // Free-text so an admin can record who it is being held for, or why.
  note: { type: String, trim: true, default: '' },

  // An inactive code stays reserved (still blocked) but cannot be assigned.
  isActive: { type: Boolean, default: true },

  // The one user permitted to hold this code. Null = reserved, blocked,
  // unusable by anyone.
  permittedUser: { type: mongoose.Schema.Types.ObjectId, ref: 'user', default: null },

  // Set when the code was actually written onto that user's account.
  assignedAt: { type: Date, default: null },

  // Kept so an assignment can be undone without losing the user's original.
  previousUserCode: { type: String, default: null },

  createdBy: { type: String, default: '' },
}, { timestamps: true });

specialReferralCodeSchema.index({ permittedUser: 1 });
specialReferralCodeSchema.index({ isActive: 1 });

/** Reserved and not yet handed to anyone — blocked from the system. */
specialReferralCodeSchema.virtual('isReserved').get(function () {
  return !this.permittedUser;
});

module.exports = mongoose.model('SpecialReferralCode', specialReferralCodeSchema);
