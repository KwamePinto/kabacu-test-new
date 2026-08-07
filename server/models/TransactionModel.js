const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({

    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'user',
        required: true
    },

    // ✅ SINGLE PRODUCT (optional)
    product: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Product'
    },

    // ✅ MULTIPLE PRODUCTS (cart)
    products: [
        {
            product: {
                type: mongoose.Schema.Types.ObjectId,
                ref: 'Product'
            },

            quantity: {
                type: Number,
                default: 1
            }
        }
    ],

    phone: String,

    amount: Number,

    walletType: {
        type: String,
        default: 'NAIRA'
    },

    paymentMethod: {
        type: String,
        default: 'PalmPay'
    },

    status: {
        type: String,

        enum: [
            'pending',
            'processing',
            'success',
            'failed',
            'refunded'
        ],

        default: 'pending'
    },

    reference: {
        type: String,
        unique: true
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
    markup: { type: Number, default: 0 },
  rpEarned: {
    type: Number,
    default: 0
},

    balanceBefore: { type: Number },
    balanceAfter:  { type: Number },

    adminCleared:   { type: Boolean, default: false },
    adminClearedAt: { type: Date },
    adminClearedBy: { type: String },

    apiResponse: {
        type: Object
    },

    webhookData: {
        type: Object
    },

    refundedAt: Date

}, {
    timestamps: true
});

transactionSchema.index({ createdAt: -1 });
transactionSchema.index({ status: 1, createdAt: -1 });
transactionSchema.index({ user: 1, createdAt: -1 });
transactionSchema.index({ paymentMethod: 1, status: 1 });
transactionSchema.index({ adminCleared: 1 });
transactionSchema.index({ phone: 1, createdAt: -1 });
transactionSchema.index({ 'apiResponse.adminDeducted': 1 });
transactionSchema.index({ 'apiResponse.refundPending': 1 });

module.exports = mongoose.model(
    'Transaction',
    transactionSchema
);