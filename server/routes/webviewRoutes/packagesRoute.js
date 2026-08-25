const express = require('express')
const router = express.Router()

const { authenticateUser } = require('../../config/authMiddleware');
const getPackages = require('../../controllers/webviewControllers/packagesController')

router.get('/',getPackages.packagesView)

router.get('/categories', getPackages.categoriesPage)
router.get('/about', getPackages.aboutPage)
router.get('/faq', getPackages.faqPage)
router.get('/privacy-policy', getPackages.privacyPolicy)
router.get('/terms', getPackages.termsOfUse)

router.post('/checkout/initiate',authenticateUser,getPackages.initiateCheckout)

router.post('/beneficiaries/add', authenticateUser, getPackages.addBeneficiary);
router.post('/beneficiaries/:id/delete', authenticateUser, getPackages.deleteBeneficiary);

router.get('/checkout',authenticateUser,getPackages.checkoutPage)

router.get('/data-form',authenticateUser,getPackages.dataForm)

// router.get('/payment/paystack',authenticateUser,getPackages.paystack)

router.get('/payment/wallet',authenticateUser,getPackages.wallet)

router.get('/wallet/checkout', authenticateUser, getPackages.walletCheckout);

router.get('/history', authenticateUser, getPackages.history);

router.get('/my-topUps', authenticateUser, getPackages.myTopUps);

router.post('/retry-transaction', authenticateUser, getPackages.retryTransaction);

router.post('/cart/add', authenticateUser, getPackages.addToCart);

router.get('/item-checkout', authenticateUser, getPackages.itemCheckout);

router.get('/my-wallet', authenticateUser, getPackages.userWallet);
/* Switching market. Signed-in only, because it is what decides which wallet the
   user spends from — signed-out visitors just set the cookie client-side. */
router.post('/my-wallet/switch-market', authenticateUser, getPackages.switchMarket);
/* Manual funding for markets with no gateway. Records the claim only — an admin
   confirms before any balance moves. */
router.post('/my-wallet/manual-topup', authenticateUser, getPackages.requestManualTopUp);

// routes
// router.get('/wallet/checkout', authenticateUser, walletController.walletCheckoutPage);
router.post('/wallet/start-topup', authenticateUser, getPackages.startTopUp);
router.post('/wallet/confirm-topup', authenticateUser, getPackages.confirmTopUp);

router.post('/wallet/pay', authenticateUser, getPackages.payWithWallet);

router.get('/user-profile', authenticateUser, getPackages.userProfile);

router.post('/edit-user-profile', authenticateUser, getPackages.editUserProfile);

router.get('/referrals', authenticateUser, getPackages.referralsPage);

/* Buying a better referral code. Nothing here moves money — a request is
   reviewed first, and approval is what charges. */
router.get ('/referrals/special-codes',        authenticateUser, getPackages.availableSpecialCodes);
router.post('/referrals/check-code',           authenticateUser, getPackages.checkCustomCode);
router.post('/referrals/request-code',         authenticateUser, getPackages.requestReferralCode);
router.post('/referrals/request/:id/cancel',   authenticateUser, getPackages.cancelReferralCodeRequest);

router.post('/referral/apply', authenticateUser, getPackages.applyReferral);

router.post('/wallet/convert-usdt', authenticateUser, getPackages.convertUSDTtoNaira);

router.post('/update-checkout/:id', authenticateUser, getPackages.editItem);

router.get('/delete-checkout/:id', authenticateUser, getPackages.deleteItem);

router.post('/wallet/preview-conversion', authenticateUser, getPackages.previewUSDTConversion);

router.post( '/palmpay/create', authenticateUser, getPackages.createPalmPayPayment);

router.post( '/palmpay/webhook', getPackages.palmPayWebhook);

router.post( '/wallet/claim-rp', authenticateUser, getPackages.claimRP);
router.post( '/wallet/transfer-rp', authenticateUser, getPackages.transferRPToBittokenHandler);

router.get('/conversion-history', authenticateUser, getPackages.conversionHistory);

// Returns active payment methods as JSON — used by the top-up modal on purchase pages
router.get('/topup-methods', authenticateUser, async (req, res) => {
  try {
    const PaymentMethod = require('../../models/PaymentMethodModel');
    const methods = await PaymentMethod.find({ isActive: true }).sort({ createdAt: 1 });
    res.json({ success: true, methods });
  } catch (err) {
    res.json({ success: false, methods: [] });
  }
});

module.exports = router;
