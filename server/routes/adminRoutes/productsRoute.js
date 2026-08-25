const express = require('express');
const router = express.Router();

const upload = require('../../config/multer');
const getProducts = require('../../controllers/adminControllers/productsController');

router.get('/create-products', getProducts.createProducts);
router.post('/add-product', upload.array('images', 3), getProducts.addProduct);
router.get('/view-products',  getProducts.viewProducts);
router.get('/view-users',      getProducts.userView);
router.get('/view-users/data', getProducts.getUsersData);
router.get('/user-details/:id', getProducts.userDetails);
router.post('/user-details/:id/deduct-wallet',    getProducts.adminDeductWallet);
router.get('/user-details/:id/available-refunds', getProducts.getAvailableRefunds);
router.post('/user-details/:id/refund-deduction', getProducts.adminRefundDeduction);
router.get('/details/:id',    getProducts.productDetails);
router.get('/view-transactions', getProducts.viewTransactions);
router.get('/view-topUps',       getProducts.viewTopUps);

router.get('/edit-product/:id',  getProducts.editProductGet);
router.post('/edit-product/:id', upload.array('images', 3), getProducts.editProductPost);
router.post('/delete-product/:id',  getProducts.deleteProduct);
router.post('/toggle-product/:id',  getProducts.toggleProduct);

/* Payment methods moved to the Payments & Wallets panel at
   /admin/payments-wallets. These stay as redirects so a bookmarked link or an
   older cached page lands somewhere useful rather than on a 404. */
router.get('/payment-methods', (req, res) => res.redirect(301, '/admin/payments-wallets'));
router.post('/payment-methods/add',      (req, res) => res.redirect(307, '/admin/payments-wallets/methods/add'));
router.post('/payment-methods/edit/:id', (req, res) => res.redirect(307, '/admin/payments-wallets/methods/edit/' + req.params.id));
router.get('/payment-methods/toggle/:id', (req, res) => res.redirect(302, '/admin/payments-wallets/methods/toggle/' + req.params.id));
router.get('/payment-methods/delete/:id', (req, res) => res.redirect(302, '/admin/payments-wallets/methods/delete/' + req.params.id));

/* Manual top-ups awaiting confirmation. Confirming is the only thing that
   credits a country wallet other than Nigeria. */
router.post('/top-ups/:id/confirm', getProducts.confirmManualTopUp);
router.post('/top-ups/:id/reject',  getProducts.rejectManualTopUp);

module.exports = router;
