const mongoose = require('mongoose');

/**
 * The tester allowlist for KabakuNew's migration-testing portal
 * (/command/testing) — see server/controllers/webviewControllers/testerAuthController.js.
 *
 * A tester logs in with email + a one-time code, never a password, so this
 * collection only ever has to record who is currently allowed in, not
 * credentials to protect. Login is gated purely on whether an email exists
 * here — added and removed from Admin → Support and Testing → Testing,
 * super admin only.
 *
 * Deliberately separate from UserModel (real customers) and UserAdminModel
 * (admin panel accounts): a tester is neither. A successful tester login
 * never touches user_token or admin_token — see grantTesterSession in
 * testerAuthController.js — so a tester meets the real site exactly as an
 * anonymous visitor would, maintenance mode aside.
 */
const testerSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
  },

  // Admin username who added them — audit trail only, shown on the Testing tab.
  addedBy: { type: String, trim: true, default: '' },

  lastLoginAt: { type: Date, default: null },

  // ── One-time login code — mirrors UserAdminModel's own 2FA fields exactly,
  //    same TTL/attempt-limit/resend-cooldown constants in the controller. ──
  otpCodeHash:   { type: String, default: null },
  otpExpires:    { type: Date,   default: null },
  otpAttempts:   { type: Number, default: 0 },
  otpLastSentAt: { type: Date,   default: null },
}, { timestamps: true });

module.exports = mongoose.model('Tester', testerSchema);
