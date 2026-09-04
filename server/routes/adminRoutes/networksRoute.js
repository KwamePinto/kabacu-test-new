const express = require('express');
const router  = express.Router();
const ctrl    = require('../../controllers/adminControllers/networksController');

router.get('/',            ctrl.viewNetworks);
router.post('/add',        ctrl.addNetwork);
router.post('/delete/:id', ctrl.deleteNetwork);

router.post('/gsubz/add',        ctrl.addGsubzPlan);
router.post('/gsubz/delete/:id', ctrl.deleteGsubzPlan);

module.exports = router;
