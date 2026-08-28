const express = require('express');
const router  = express.Router();
const upload  = require('../../config/multer');
const ctrl    = require('../../controllers/adminControllers/supportController');

router.get('/',                    ctrl.viewPanel);

// Any admin may file a report. Up to 3 screenshots ride along with it —
// config/multer.js already caps a request to 3 files total.
router.post('/report',             upload.array('screenshots', 3), ctrl.createReport);
router.post('/report/:id/remind',  ctrl.remindReport);

/* Super-admin-only. The guard lives in the controller, matching how the rest
   of the panel does it (see userAdminController and damageControlController) —
   there is no role middleware to hang it off. */
router.post('/developers',           ctrl.addDeveloper);
router.post('/developers/:id/remove', ctrl.removeDeveloper);
router.post('/report/:id/update',  ctrl.updateReport);
router.post('/report/:id/delete',  ctrl.deleteReport);

module.exports = router;
