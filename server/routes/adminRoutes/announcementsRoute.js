const express = require('express');
const router  = express.Router();

const upload = require('../../config/multer');
const ctrl   = require('../../controllers/adminControllers/announcementsController');

// `image` is optional on every write — banners/popups may also reuse an
// existing file or point at a pasted URL instead.
router.get('/',            ctrl.viewPanel);
router.post('/create',     upload.single('image'), ctrl.create);
router.post('/:id/update', upload.single('image'), ctrl.update);
router.post('/:id/toggle', ctrl.toggle);
router.post('/:id/delete', ctrl.remove);

module.exports = router;
