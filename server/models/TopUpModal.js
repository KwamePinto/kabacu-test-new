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
            'NAIRA'
        ],
        required: true
    },

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

    expiresAt: {
        type: Date,
        default: () => Date.now() + (5 * 60 * 1000)
    }

}, {
    timestamps: true
});

topupSchema.index({ createdAt: -1 });
topupSchema.index({ user: 1, createdAt: -1 });
topupSchema.index({ status: 1 });

module.exports =
    mongoose.model(
        'TopUp',
        topupSchema
    );