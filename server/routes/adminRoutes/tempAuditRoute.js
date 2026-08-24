/** TEMPORARY — see TEMP-AUDIT-REMOVAL.md */
const express = require('express');
const router  = express.Router();
const ctrl    = require('../../controllers/adminControllers/tempAuditController');

router.get('/',            ctrl.viewPanel);
router.post('/run',        ctrl.runAudit);
router.get('/export.csv',  ctrl.exportCsv);

module.exports = router;
