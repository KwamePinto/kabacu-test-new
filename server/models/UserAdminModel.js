const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const userAdminSchema = new Schema({
  username:         { type: String, required: true },
  email:            { type: String, required: true, unique: true,
                      match: /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/ },
  password:         { type: String, required: true },
  role:             { type: String, required: true, enum: ['super_admin', 'senior_admin', 'junior_admin'] },
  phone:            { type: String, default: '' },
  bio:              { type: String, default: '' },
  department:       { type: String, default: '' },
  profileCompleted:           { type: Boolean, default: false },
  isActive:                   { type: Boolean, default: true },
  addedBy:                    { type: mongoose.Schema.Types.ObjectId, ref: 'userAdmin', default: null },
  resetPasswordRequested:     { type: Boolean, default: false },
  resetPasswordRequestedAt:   { type: Date, default: null },
  resetPasswordToken:         { type: String, default: null },
  resetPasswordExpires:       { type: Date, default: null },

  // ── Login 2FA ─────────────────────────────────────────────────────────────
  // Every admin login issues a one-time code by email; the session is not
  // authenticated until it is verified.
  //
  // The code is stored HASHED, never in plain text: an admin collection dump
  // would otherwise hand over a live second factor. Attempts are counted so a
  // 6-digit code cannot be brute-forced, and the expiry bounds the window.
  twoFactorCodeHash:  { type: String, default: null },
  twoFactorExpires:   { type: Date,   default: null },
  twoFactorAttempts:  { type: Number, default: 0 },
  twoFactorLastSentAt:{ type: Date,   default: null },
}, { timestamps: true });

const UserAdminModel = mongoose.model('userAdmin', userAdminSchema);
module.exports = UserAdminModel;
