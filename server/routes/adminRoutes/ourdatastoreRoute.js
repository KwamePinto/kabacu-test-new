const express = require('express');
const router  = express.Router();
const ctrl    = require('../../controllers/adminControllers/ourdatastoreController');

router.get('/', ctrl.viewDashboard);
router.get('/data', ctrl.fetchData);

module.exports = router;
