const mongoose = require('mongoose');

/**
 * One row per commission PAYOUT — not per referral. A referred user can earn
 * their referrer commission on every purchase they make after qualifying, so
 * this is the event-level ledger: what the referrer sees when they open
 * "Commissions" on the referrals page, and what an admin sees on a user's
 * Commissions tab. Referral.commissionEarned/commissionCount stay as the
 * running total per referred user (used to enforce the lifetime cap); this
 * collection is what makes each individual payout visible with a timestamp.
 */
const referralCommissionSchema = new mongoose.Schema({
  referrer: { type: mongoose.Schema.Types.ObjectId, ref: 'user', required: true },
  referred: { type: mongoose.Schema.Types.ObjectId, ref: 'user', required: true },
  referral: { type: mongoose.Schema.Types.ObjectId, ref: 'Referral', required: true },

  // What the referrer was actually credited, in the market below.
  amount: { type: Number, required: true },

  // Wallet-aware: this commission was paid in the SAME market/currency the
  // referred user's purchase was made in, not a fixed admin-chosen type.
  // `market` is the ISO country code (walletUtil's market code — 'NG' for
  // the Naira field, others for their countryBalances.<code> entry).
  // code/symbol are denormalized off utils/country's CURRENCIES table at
  // payout time, so a later edit to that table never rewrites history.
  market:         { type: String, required: true },
  currencyCode:   { type: String, default: '' },
  currencySymbol: { type: String, default: '' },

  // What the referred user actually spent — context for the payout, not
  // itself credited to anyone.
  purchaseAmount: { type: Number, default: 0 },
  transaction:    { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', default: null },
}, { timestamps: true });

referralCommissionSchema.index({ referrer: 1, createdAt: -1 });

module.exports = mongoose.model('ReferralCommission', referralCommissionSchema);
