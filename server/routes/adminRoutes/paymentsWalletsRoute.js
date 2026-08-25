const express = require('express');
const router = express.Router();

const getProducts = require('../../controllers/adminControllers/productsController');

/**
 * Payments & Wallets — the panel that decides which markets are live.
 *
 * Country wallets and the payment methods that fund them are two halves of one
 * screen, so they share a route file. The handlers still live in
 * productsController alongside the payment-method CRUD they grew out of.
 */

router.get('/', getProducts.viewPaymentMethods);

// Country wallets
router.post('/countries/add',           getProducts.addCountryWallet);
router.post('/countries/edit/:id',      getProducts.editCountryWallet);
router.get('/countries/toggle/:id',     getProducts.toggleCountryWallet);
router.get('/countries/delete/:id',     getProducts.deleteCountryWallet);

// Payment methods, scoped to a market
router.post('/methods/add',             getProducts.addPaymentMethod);
router.post('/methods/edit/:id',        getProducts.editPaymentMethod);
router.get('/methods/toggle/:id',       getProducts.togglePaymentMethod);
router.get('/methods/delete/:id',       getProducts.deletePaymentMethod);

module.exports = router;
