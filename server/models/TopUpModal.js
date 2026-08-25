const mongoose = require('mongoose');

const topupSchema = new mongoose.Schema({

    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'user',
        required: true
    },

    amount: {
        type: Number,
        required: true
    },
    nairaAmount:{
      type: Number,
        
    },

    balanceType: {
        type: String,
        enum: [
            'BTT',
            'RP',
            'USDT',
            'NAIRA',
            // A country wallet other than Nigeria. Which one is in
            // `walletCountry` — kept out of this enum so adding a market never
            // needs a schema change or a migration of existing rows.
            'COUNTRY'
        ],
        required: true
    },

    /**
     * Which country wallet this funds, as an ISO code.
     *
     * NAIRA top-ups are Nigerian by definition and carry 'NG'. Rows created
     * before country wallets existed have no value and are read as Nigeria,
     * which is what they were.
     */
    walletCountry: {
        type: String,
        default: 'NG',
        uppercase: true,
        trim: true
    },

    /**
     * Set when funding came through a method with no gateway behind it: the
     * user says they have paid and an admin confirms it before any money is
     * credited. Nothing here credits a wallet on its own.
     */
    isManual: {
        type: Boolean,
        default: false
    },

    // Whatever the user quotes as proof — a transfer reference, a mobile money id.
    userReference: {
        type: String,
        default: '',
        trim: true
    },

    /**
     * Balance either side of the credit. Recorded so the account statement has
     * a chain that joins up — without these the row shows an amount with no
     * before/after and the running balance breaks at that point.
     */
    balanceBefore: { type: Number, default: null },
    balanceAfter:  { type: Number, default: null },

    confirmedBy: { type: String, default: '' },
    confirmedAt: { type: Date, default: null },
    rejectedReason: { type: String, default: '' },

    status: {
        type: String,
        enum: [
            'PENDING',
            'COMPLETED',
            'FAILED'
        ],
        default: 'PENDING'
    },

    reference: {
        type: String,
        unique: true,
        sparse: true
    },

    paymentMethod: {
        type: String
    },

    palmPayOrderId: String,

    sdkSessionId: String,

    payToken: String,

    checkoutUrl: String,

    walletCredited: {
        type: Boolean,
        default: false
    },

    webhookVerified: {
        type: Boolean,
        default: false
    },

    apiResponse: Object,

    webhookData: Object,

    /**
     * Gateway sessions die in five minutes. Manual top-ups deliberately get no
     * expiry: a bank transfer can take a day to land, and expiring the record
     * would strand a user who has genuinely paid.
     */
    expiresAt: {
        type: Date,
        default: function () {
            return this.isManual ? null : Date.now() + (5 * 60 * 1000);
        }
    }

}, {
    timestamps: true
});

topupSchema.index({ createdAt: -1 });
topupSchema.index({ user: 1, createdAt: -1 });
topupSchema.index({ status: 1 });
// The admin queue: manual top-ups awaiting confirmation.
topupSchema.index({ isManual: 1, status: 1, createdAt: -1 });

module.exports =
    mongoose.model(
        'TopUp',
        topupSchema
    );