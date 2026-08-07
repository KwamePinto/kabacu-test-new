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
    }


})

userSchema.index({ createdAt: -1 });
userSchema.index({ isVerified: 1 });

const UserModel = mongoose.model('user', userSchema);
module.exports = UserModel;



