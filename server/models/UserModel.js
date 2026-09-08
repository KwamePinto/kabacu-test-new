const mongoose = require('mongoose');
const Schema = mongoose.Schema;


const userSchema = new Schema({
    username: { type: String, required: true },
    email: { type: String, 
        required: true, 
        unique:true,
        match:/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/
    },
    country: { type: String },

    /**
     * Which country wallet the user's money is currently in, as an ISO code.
     *
     * Separate from `country` (where they registered) and from the market they
     * are browsing, because the three move independently: browsing Japan when
     * Japan has no wallet must leave the money where it is. This only ever
     * changes to a country that has an active wallet, so it always names a
     * market the user can actually pay in.
     */
    walletCountry: { type: String, default: 'NG', uppercase: true, trim: true },
    phone_number: { type: String },
    minerId: { type: Number, unique: true,sparse: true },
    password: { type: String, required: true },
    role: { type: String, required: true },
    walletBalance: {
        type: Number,
        default: 0
},
loginAttempts: {
    type: Number,
    default: 0
},
rpBalance: {
   type: Number,
   default: 0
},

lockUntil: Date,

    isVerified: {
        type: Boolean,
        default: false
    },

verificationToken: String,

verificationTokenExpires: Date,

forgotPasswordToken: String,

forgotPasswordTokenExpires: Date,
    checkout:{
        type: mongoose.Schema.Types.ObjectId,
            ref: 'checkout',
    },
      cart:{
        type: mongoose.Schema.Types.ObjectId,
            ref: 'cart',
    },
      wallet:{
        type: mongoose.Schema.Types.ObjectId,
            ref: 'Wallet',
    },
     topUp:{
        type: mongoose.Schema.Types.ObjectId,
            ref: 'TopUp',
    },

    // ── Referrals ────────────────────────────────────────────────────────
    // Every user gets a code they can share. Backfilled for existing accounts
    // by scripts/backfill-referral-codes.js.
    referralCode: { type: String, unique: true, sparse: true, uppercase: true, trim: true },

    // Who referred this user. Set once and never changed — the Referral
    // collection is the authoritative link record and enforces that.
    referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'user', default: null },

    // Flipped the first time this user completes a purchase, which is the
    // moment their referrer becomes eligible for a reward.
    hasMadeFirstPurchase: { type: Boolean, default: false },

    // ── Signup bonus ─────────────────────────────────────────────────────
    // Set when the promotion paid out, so it can never be credited twice —
    // OTP verification can be retried, and a resend must not pay again.
    signupBonusPaidAt:  { type: Date, default: null },
    /* 'money' stays legal for historic rows written before the signup bonus
       moved to BTT/USDT — see the same note on ReferralModel.rewardType. */
    signupBonusType:    { type: String, enum: ['money', 'rewardpoint', 'BTT', 'USDT', null], default: null },
    signupBonusAmount:  { type: Number, default: 0 },

    // ── WhatsApp verification ────────────────────────────────────────────
    // The number in E.164 digits, no plus ("2348012345678"), which is the
    // form the WhatsApp Cloud API wants. `phone_number` above is the free-
    // text one collected at signup and is NOT trusted — this field only
    // ever holds a number that answered a code.
    //
    // Unique and sparse on purpose: this is the anti-farming lever for the
    // signup bonus. Email costs nothing to obtain in bulk, so without
    // one-account-per-number the referral requirement can be satisfied by
    // one person with one phone and the promotion pays out indefinitely.
    // Sparse so the many accounts with no number at all do not collide.
    whatsappNumber:      { type: String, unique: true, sparse: true, trim: true, default: undefined },

    // The local 11-digit form ("08012345678") kept alongside, because that
    // is what beneficiaries and the data-purchase inputs use throughout
    // the app. Derived, never entered.
    whatsappLocalNumber: { type: String, trim: true, default: null },

    whatsappVerifiedAt:  { type: Date, default: null },

    // Hashed, unlike the email OTP which is stored in the clear. This code
    // gates a cash bonus, so a leaked database read should not hand out
    // working codes.
    whatsappToken:        { type: String, default: null },
    whatsappTokenExpires: { type: Date, default: null },

    // Rate limiting lives on the document rather than in memory so it
    // survives a restart and holds across multiple app instances. Each
    // template message costs money, so an unthrottled resend is a bill.
    whatsappSendCount:   { type: Number, default: 0 },
    whatsappLastSentAt:  { type: Date, default: null },
    whatsappTries:       { type: Number, default: 0 },

    // Set when the user dismisses the "finish setting up" banner. Purely
    // cosmetic — it never affects eligibility.
    setupBannerDismissedAt: { type: Date, default: null },
})

userSchema.index({ createdAt: -1 });
userSchema.index({ isVerified: 1 });
userSchema.index({ referredBy: 1 });
/* The signup-bonus page counts, per referrer, how many referred users have
   finished BOTH verifications. That query filters on referredBy plus both
   verification states, so it gets its own compound index rather than
   scanning every referred user each time the page is opened. */
userSchema.index({ referredBy: 1, isVerified: 1, whatsappVerifiedAt: 1 });

/**
 * Account age. The schema has never had timestamps, so createdAt does not
 * exist on the ~6k existing accounts — the ObjectId's embedded timestamp is
 * the only creation time available, and it is present on every document.
 */
userSchema.methods.createdAtSafe = function () {
    return this._id.getTimestamp();
};

const UserModel = mongoose.model('user', userSchema);
module.exports = UserModel;



