const express = require('express');
const router = express.Router();

const upload = require('../../config/multer');
const getProducts = require('../../controllers/adminControllers/productsController');

router.get('/create-products', getProducts.createProducts);
router.post('/add-product', upload.array('images', 3), getProducts.addProduct);
router.get('/view-products',  getProducts.viewProducts);
router.get('/view-users',     getProducts.userView);
router.get('/user-details/:id', getProducts.userDetails);
router.post('/user-details/:id/deduct-wallet', getProducts.adminDeductWallet);
router.get('/details/:id',    getProducts.productDetails);
router.get('/view-transactions', getProducts.viewTransactions);
router.get('/view-topUps',       getProducts.viewTopUps);

router.get('/edit-product/:id',  getProducts.editProductGet);
router.post('/edit-product/:id', upload.array('images', 3), getProducts.editProductPost);
router.post('/delete-product/:id',  getProducts.deleteProduct);
router.post('/toggle-product/:id',  getProducts.toggleProduct);

router.get('/payment-methods',          getProducts.viewPaymentMethods);
router.post('/payment-methods/add',     getProducts.addPaymentMethod);
router.post('/payment-methods/edit/:id', getProducts.editPaymentMethod);
router.get('/payment-methods/toggle/:id', getProducts.togglePaymentMethod);
router.get('/payment-methods/delete/:id', getProducts.deletePaymentMethod);

module.exports = router;
