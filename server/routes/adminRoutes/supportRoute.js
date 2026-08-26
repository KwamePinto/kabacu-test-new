const express = require('express');
const router  = express.Router();
const ctrl    = require('../../controllers/adminControllers/supportController');

router.get('/',                    ctrl.viewPanel);

// Any admin may file a report.
router.post('/report',             ctrl.createReport);

/* Super-admin-only. The guard lives in the controller, matching how the rest
   of the panel does it (see userAdminController and damageControlController) —
   there is no role middleware to hang it off. */
router.post('/dev-info',           ctrl.updateDevInfo);
router.post('/report/:id/update',  ctrl.updateReport);
router.post('/report/:id/delete',  ctrl.deleteReport);

module.exports = router;
