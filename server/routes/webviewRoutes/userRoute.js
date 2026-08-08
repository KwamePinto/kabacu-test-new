const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');

const getUser = require('../../controllers/webviewControllers/userController');
const { authenticateUser, optionalUser } = require('../../config/authMiddleware');
const UserNotification = require('../../models/UserNotificationModel');

// ── Rate limiters ─────────────────────────────────────────────────────────────

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 10,
  message: 'Too many login attempts. Please wait 15 minutes before trying again.',
  standardHeaders: true,
  legacyHeaders: false,
});

const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,  // 1 hour
  max: 5,
  message: 'Too many accounts created from this IP. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

const passwordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 5,
  message: 'Too many password reset attempts. Please wait 15 minutes and try again.',
  standardHeaders: true,
  legacyHeaders: false,
});

const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 10,
  message: 'Too many OTP attempts. Please wait 15 minutes before trying again.',
  standardHeaders: true,
  legacyHeaders: false,
});

const resendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 3,
  message: 'Too many resend requests. Please wait 15 minutes before trying again.',
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Auth routes ───────────────────────────────────────────────────────────────

router.get('/login', getUser.login);
router.post('/login', loginLimiter, getUser.loginPost);

router.get('/signup', getUser.signup);
router.post('/signup', signupLimiter, getUser.signupPost);

router.get('/logout', getUser.logout);
router.get('/refresh-captcha', getUser.refreshCaptcha);

router.get('/reset-password', getUser.resetPassword);
router.post('/reset-password', passwordLimiter, getUser.resetPasswordPost);

router.get('/verify-otp', getUser.verifyOTP);
router.post('/verify-otp', otpLimiter, getUser.verifyOTPPost);
router.post('/resend-otp', resendLimiter, getUser.resendOTP);

// ── Forgot password flow ──────────────────────────────────────────────────────

router.get('/forgot-password', getUser.forgotPassword);
router.post('/forgot-password', passwordLimiter, getUser.forgotPasswordPost);

router.get('/forgot-password-otp', getUser.forgotPasswordOTP);
router.post('/forgot-password-otp', otpLimiter, getUser.forgotPasswordOTPPost);

router.get('/forgot-password-reset', getUser.forgotPasswordReset);
router.post('/forgot-password-reset', passwordLimiter, getUser.forgotPasswordResetPost);

// ── Profile change password flow (must be logged in) ──────────────────────────

router.get('/profile-change-password', authenticateUser, getUser.profileChangePassword);
router.post('/profile-change-password', authenticateUser, passwordLimiter, getUser.profileChangePasswordPost);

router.get('/profile-change-password-otp', authenticateUser, getUser.profileChangePasswordOTP);
router.post('/profile-change-password-otp', authenticateUser, otpLimiter, getUser.profileChangePasswordOTPPost);

router.get('/profile-change-password-new', authenticateUser, getUser.profileChangePasswordNew);
router.post('/profile-change-password-new', authenticateUser, passwordLimiter, getUser.profileChangePasswordNewPost);

// ── User notifications (cookie-auth, returns JSON) ────────────────────────────

router.get('/notifications', optionalUser, async (req, res) => {
  if (!req.user) return res.status(401).json({ success: false, notifications: [], unreadCount: 0 });
  try {
    const notifications = await UserNotification.find({ user: req.user.id })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();
    const unreadCount = notifications.filter(n => !n.read).length;
    res.json({ success: true, notifications, unreadCount });
  } catch (err) {
    res.json({ success: false, notifications: [], unreadCount: 0 });
  }
});

router.post('/notifications/read-all', optionalUser, async (req, res) => {
  if (!req.user) return res.status(401).json({ success: false });
  try {
    await UserNotification.updateMany({ user: req.user.id, read: false }, { read: true });
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false });
  }
});

router.get('/rp-balance', authenticateUser, async (req, res) => {
  try {
    const User = require('../../models/UserModel');
    const user = await User.findById(req.user.id).select('rpBalance').lean();
    res.json({ success: true, rpBalance: user?.rpBalance || 0 });
  } catch (err) {
    res.json({ success: true, rpBalance: 0 });
  }
});

module.exports = router;