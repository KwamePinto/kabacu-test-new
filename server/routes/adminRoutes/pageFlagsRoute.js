const express = require('express');
const router  = express.Router();

const upload = require('../../config/multer');
const ctrl   = require('../../controllers/adminControllers/pageFlagsController');

// No GET here — Page Visibility is rendered as a section of Admin → Settings
// (settingsController.js / views/adminview/settings.ejs), not its own page.
router.post('/:key', upload.single('comingSoonImage'), ctrl.save);

module.exports = router;
