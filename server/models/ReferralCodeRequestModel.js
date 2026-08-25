const mongoose = require('mongoose');

/**
 * A user asking to buy a referral code, held for an admin to approve.
 *
 * ── Why requests are not instant ────────────────────────────────────────────
 * A custom code is text a user writes that then gets shown to other people, so
 * it needs a human to read it before it goes live. Nothing stops someone
 * choosing a slur or an impersonation, and once a code is issued it is
 * advertised, shared and permanent. Reserved codes go through the same queue so
 * there is one flow and one audit trail rather than two.
 *
 * ── Why the wallet is charged on APPROVAL, not on request ───────────────────
 * Debiting up front would mean refunding every rejection, and a refund path is
 * a second place for money to go wrong. Holding the charge until approval means
 * a rejected request never touched the balance, so there is nothing to reverse.
 *
 * The balance is checked when the request is made too — telling a user their
 * funds are short at request time is far better than approving something that
 * then cannot be paid for — but that check is advisory. The authoritative one
 * is the atomic debit at approval.
 */
const referralCodeRequestSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'user',
    required: true,
  },

  type: {
    type: String,
    enum: ['special', 'custom'],
    required: true,
  },

  /**
   * The code being asked for, uppercased. For `special` this is a copy of the
   * pool row's code, kept so the request still reads correctly if the pool row
   * is later deleted.
   */
  code: { type: String, required: true, uppercase: true, trim: true },

  // Set for `special` requests: which pool row is being claimed.
  specialCode: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SpecialReferralCode',
    default: null,
  },

  /**
   * Price and bonuses quoted to the user when they asked, frozen here.
   *
   * A user must get what they agreed to. If an admin changes the price or the
   * bonuses while a request sits in the queue, approving on today's numbers
   * would give someone terms they never accepted — so approval uses these,
   * not current settings.
   */
  price: { type: Number, default: 0, min: 0 },
  rewardBonusPercent:     { type: Number, default: 0, min: 0 },
  commissionBonusPercent: { type: Number, default: 0, min: 0 },

  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'cancelled'],
    default: 'pending',
  },

  // Which market's wallet was, or will be, charged. Codes are priced in one
  // currency per market, the same way products are.
  walletCountry: { type: String, default: 'NG', uppercase: true, trim: true },

  /**
   * Set once money has actually moved. The compare-and-swap on this field is
   * what stops a double-click, or two admins working the queue at once, from
   * charging the user twice.
   */
  charged:       { type: Boolean, default: false },
  balanceBefore: { type: Number, default: null },
  balanceAfter:  { type: Number, default: null },

  // Recorded so an approval or rejection can always be traced to a person.
  reviewedBy:      { type: String, default: '' },
  reviewedAt:      { type: Date, default: null },
  autoApproved:    { type: Boolean, default: false },
  rejectionReason: { type: String, default: '', trim: true },

  // The code row created on approval.
  issuedCode: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ReferralCode',
    default: null,
  },
}, { timestamps: true });

// The admin queue, newest first.
referralCodeRequestSchema.index({ status: 1, createdAt: -1 });
referralCodeRequestSchema.index({ user: 1, createdAt: -1 });

/**
 * One pending request per user at a time.
 *
 * Without this a user could queue twenty custom codes and make the admin reject
 * each one, and could tie up several reserved codes at once so nobody else can
 * claim them. Partial, so their settled requests are unconstrained.
 */
referralCodeRequestSchema.index(
  { user: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: 'pending' } },
);

module.exports = mongoose.model('ReferralCodeRequest', referralCodeRequestSchema);
