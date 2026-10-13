const router  = require('express').Router();
const apiAuth = require('../middleware/apiAuth');

const auth          = require('../controllers/apiControllers/authController');
const products      = require('../controllers/apiControllers/productController');
const checkout      = require('../controllers/apiControllers/checkoutController');
const wallet        = require('../controllers/apiControllers/walletController');
const transaction   = require('../controllers/apiControllers/transactionController');
const profile       = require('../controllers/apiControllers/profileController');
const publicCourses = require('../controllers/apiControllers/publicCoursesController');
const userNotif     = require('../controllers/apiControllers/userNotificationsController');

// ── Auth (public) ──────────────────────────────────────────
router.post('/auth/login',          auth.login);
router.post('/auth/register',       auth.register);
router.post('/auth/reset-password', auth.resetPassword);
router.post('/auth/verify-otp',     auth.verifyOTP);
router.post('/auth/resend-otp',     auth.resendOTP);

// ── Products (public) ──────────────────────────────────────
router.get('/products',      products.getProducts);
router.get('/products/data', products.getDataProducts);
router.get('/products/:id',  products.getProduct);

// ── Checkout (auth required) ───────────────────────────────
router.post('/checkout',         apiAuth, checkout.initiateCheckout);
router.get('/checkout',          apiAuth, checkout.getCheckout);
router.put('/checkout/:id',      apiAuth, checkout.updateCheckout);
router.delete('/checkout/:id',   apiAuth, checkout.deleteCheckout);

// ── Wallet (auth required) ─────────────────────────────────
router.get('/wallet',                    apiAuth, wallet.getWallet);
router.post('/wallet/pay',               apiAuth, wallet.payWithWallet);
router.post('/wallet/topup/start',       apiAuth, wallet.startTopUp);
router.post('/wallet/topup/confirm',     apiAuth, wallet.confirmTopUp);
router.post('/wallet/claim-rp',          apiAuth, wallet.claimRP);
router.post('/wallet/convert-usdt',      apiAuth, wallet.convertUSDTtoNaira);
router.post('/wallet/preview-convert',   apiAuth, wallet.previewUSDTConversion);
router.post('/wallet/palmpay',           apiAuth, wallet.createPalmPayPayment);

// ── PalmPay webhook (no auth — signed by PalmPay) ──────────
router.post('/palmpay/webhook', wallet.palmPayWebhook);

// ── Transactions (auth required) ───────────────────────────
router.get('/transactions',           apiAuth, transaction.getTransactions);
router.post('/transactions/:id/retry', apiAuth, transaction.retryTransaction);

// ── Profile (auth required) ────────────────────────────────
router.get('/profile', apiAuth, profile.getProfile);
router.put('/profile', apiAuth, profile.updateProfile);

// ── Course access (public — used by external course website) ──
router.get('/public/course-access', publicCourses.courseAccess);

// ── RP credit from CSkillsHub (HMAC-signed, no session auth — see
//    publicCoursesController.js::creditRp for the full contract) ──
router.post('/public/course-rp/credit', publicCourses.creditRp);

// ── User notifications ─────────────────────────────────────
router.get('/notifications',           apiAuth, userNotif.getNotifications);
router.post('/notifications/read-all', apiAuth, userNotif.markAllRead);

module.exports = router;
