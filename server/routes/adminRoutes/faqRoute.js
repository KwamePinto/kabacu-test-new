const express = require('express');
const router  = express.Router();
const ctrl    = require('../../controllers/adminControllers/faqAdminController');

router.get('/',              ctrl.viewPanel);
router.post('/create',       ctrl.createFaq);
router.post('/:id/update',   ctrl.updateFaq);
router.post('/:id/delete',   ctrl.deleteFaq);

module.exports = router;
