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
})

userSchema.index({ createdAt: -1 });
userSchema.index({ isVerified: 1 });
userSchema.index({ referredBy: 1 });

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



