const express = require('express');
const router  = express.Router();
const ctrl    = require('../../controllers/adminControllers/referralsController');

router.get('/',              ctrl.viewPanel);
router.post('/settings',     ctrl.saveSettings);

module.exports = router;
