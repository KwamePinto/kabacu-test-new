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

  // BTT and USDT are real, spendable wallet currencies — crediting one is a
  // genuine payout rather than the store-scoped Naira or a package grant, and
  // it works the same for a referrer in any market.
  rewardType: {
    type: String,
    enum: ['rewardpoint', 'BTT', 'USDT'],
    default: 'rewardpoint',
  },

  // Used by every reward type: rewardpoint credits rpBalance, BTT/USDT credit
  // the matching wallet balance.
  amount: { type: Number, default: 0, min: 0 },

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

    // Same three currencies as the referral reward: a real wallet credit
    // (BTT/USDT) or reward points. Money and data are not offered — money
    // was replaced by BTT/USDT everywhere else in the programme, and a data
    // bundle needs a destination phone number a brand-new account has not
    // given yet.
    rewardType: { type: String, enum: ['rewardpoint', 'BTT', 'USDT'], default: 'rewardpoint' },

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

    // No reward-type choice any more — commission is always a percentage of
    // what the referred user actually spent, paid out in whatever
    // currency/market that purchase was made in (see referralService's
    // handleCommission and utils/wallet.js). One admin-set number is the
    // whole configuration.
    percent: { type: Number, default: 0, min: 0, max: 100 },

    // Lifetime ceiling on what a single referred user can ever generate for
    // their referrer. 0 = unlimited. Keeps an open-ended liability bounded.
    maxPerReferredUser: { type: Number, default: 0, min: 0 },
  },

  // ── Paid codes: special (from the admin pool) and custom (user-chosen) ────
  //
  // Priced and bonused separately, because they are not the same product. A
  // reserved code is scarce — once someone buys KABACU nobody else can — while
  // a custom code is only limited by what is still free. The bonus is what a
  // buyer is actually paying for: it multiplies the referral reward their code
  // earns, so a paid code out-earns the free system one.
  paidCodes: {
    // Master switch for the whole request flow. Off means users see no option
    // to buy a code and any direct request is refused.
    isActive: { type: Boolean, default: false },

    /**
     * Skip the review queue and issue immediately.
     *
     * Off by default and it should stay off while volumes are low: the queue
     * exists so a person reads a custom code before it is shown to other
     * users. Turning this on trades that safety for throughput, which is a
     * reasonable call once requests outpace review — the admin's own words for
     * it were "in case they become numerous".
     */
    autoApprove: { type: Boolean, default: false },

    /**
     * Each kind carries TWO bonuses, set independently.
     *
     *   rewardBonusPercent      uplift on the one-off referral reward. Paid once
     *                           per referral, so the cost is bounded and known.
     *   commissionBonusPercent  uplift on the ongoing per-purchase commission.
     *                           Applies for as long as the referred user keeps
     *                           buying, so it is an open-ended liability.
     *
     * Separating them lets an admin be generous on the one-off while leaving the
     * ongoing commission at zero — a paid code then earns the standard
     * commission with no uplift, which keeps the long tail predictable.
     */
    special: {
      /**
       * Default price for pool codes. A code with its own non-zero price keeps
       * that price — per-code beats the default, so an admin can still sell one
       * memorable code for more than the rest.
       */
      price: { type: Number, default: 0, min: 0 },

      // What a special code is actually bought with. Deducted from that flat
      // wallet balance directly — BTT and USDT are not per-country like Naira,
      // so this never touches the country-market wallet machinery.
      currency: { type: String, enum: ['BTT', 'USDT'], default: 'BTT' },

      rewardBonusPercent:     { type: Number, default: 0, min: 0, max: 500 },
      commissionBonusPercent: { type: Number, default: 0, min: 0, max: 500 },
    },

    custom: {
      price:                  { type: Number, default: 0, min: 0 },
      rewardBonusPercent:     { type: Number, default: 0, min: 0, max: 500 },
      commissionBonusPercent: { type: Number, default: 0, min: 0, max: 500 },

      /**
       * Length bounds for a user-chosen code. The floor stops single-character
       * land grabs; the ceiling keeps a code short enough to say out loud,
       * which is the whole point of buying one.
       */
      minLength: { type: Number, default: 4,  min: 3,  max: 32 },
      maxLength: { type: Number, default: 16, min: 4,  max: 64 },
    },
  },
}, { timestamps: true });

/** Always returns the single settings document, creating it on first use. */
referralSettingsSchema.statics.getSettings = async function () {
  let doc = await this.findOne();
  if (!doc) doc = await this.create({});
  return doc;
};

module.exports = mongoose.model('ReferralSettings', referralSettingsSchema);
