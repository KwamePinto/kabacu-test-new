const express = require('express');
const router  = express.Router();
const ctrl    = require('../../controllers/adminControllers/referralsController');

router.get('/',              ctrl.viewPanel);
router.post('/settings',     ctrl.saveSettings);

// Special / vanity codes — admin-only, no client-facing purchase flow yet
router.get('/user-lookup',           ctrl.lookupUser);
router.post('/special',              ctrl.createSpecialCode);
router.post('/special/:id/edit',     ctrl.editSpecialCode);
router.post('/special/:id/assign',   ctrl.assignSpecialCode);
router.post('/special/:id/unassign', ctrl.unassignSpecialCode);
router.post('/special/:id/toggle',   ctrl.toggleSpecialCode);
router.post('/special/:id/delete',   ctrl.deleteSpecialCode);

// Bulk reservation: one comma-separated paste instead of one code at a time
router.post('/special/bulk',         ctrl.bulkCreateSpecialCodes);

// Review queue for codes users have asked to buy. Approving charges the wallet.
router.get ('/requests',             ctrl.listCodeRequests);
router.post('/requests/:id/approve', ctrl.approveCodeRequest);
router.post('/requests/:id/reject',  ctrl.rejectCodeRequest);

module.exports = router;
