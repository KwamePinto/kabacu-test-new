const express = require('express');
const router  = express.Router();
const ctrl    = require('../../controllers/adminControllers/damageControlController');

router.get('/',                    ctrl.viewDamageControl);
router.get('/tab-data',            ctrl.getTabData);
router.post('/deduct',             ctrl.deductWallet);
router.post('/resolve',            ctrl.resolveTransaction);
router.post('/clear',              ctrl.clearTransaction);
router.post('/refund-deduction',   ctrl.adminRefundDeduction);
router.post('/approve-refund',     ctrl.approveRefundRequest);

// Short delivery — provider delivered only part of a split bundle
router.get('/short-delivery',              ctrl.shortDeliveryRows);
router.post('/short-delivery/:id/refund',  ctrl.shortDeliveryRefund);
router.post('/short-delivery/:id/topup',   ctrl.shortDeliveryTopUp);

module.exports = router;
