const express = require('express');
const router  = express.Router();
const ctrl    = require('../../controllers/adminControllers/damageControlController');

router.get('/',                    ctrl.viewDamageControl);
router.post('/deduct',             ctrl.deductWallet);
router.post('/resolve',            ctrl.resolveTransaction);
router.post('/clear',              ctrl.clearTransaction);
router.post('/refund-deduction',   ctrl.adminRefundDeduction);
router.post('/approve-refund',     ctrl.approveRefundRequest);

module.exports = router;
