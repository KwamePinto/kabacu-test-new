const express = require('express');
const router  = express.Router();
const ctrl    = require('../../controllers/adminControllers/gsubzController');

router.get('/',           ctrl.viewDashboard);
router.get('/data',       ctrl.fetchData);
router.post('/reconcile', ctrl.reconcileTransactions);

module.exports = router;
