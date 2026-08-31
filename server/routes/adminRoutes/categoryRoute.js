const express = require('express');
const router = express.Router();
const getCategory = require('../../controllers/adminControllers/categoryController');

router.get('/view-category',  getCategory.viewCategory);
router.get('/create-category', getCategory.createCategory);
router.post('/add-category',   getCategory.createCategoryPost);
router.post('/edit-category/:id',   getCategory.editCategory);
router.post('/delete-category/:id', getCategory.deleteCategory);
router.post('/toggle-games', getCategory.toggleGames);

module.exports = router;
