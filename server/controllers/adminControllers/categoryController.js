const adminLayouts = 'layouts/adminLayout';
const { authenticateAdminUser } = require('../../config/authMiddleware');
const Category = require('../../models/CategoryModal');
const SiteSettings = require('../../models/SiteSettingsModel');
const { clearCache: clearGamesCache } = require('../../middleware/gamesMiddleware');

exports.viewCategory = [authenticateAdminUser, async (req, res) => {
  try {
    const [category, settings] = await Promise.all([
      Category.find({ is_deleted: { $ne: 1 } }).sort({ createdAt: -1 }).lean(),
      SiteSettings.getSettings(),
    ]);
    res.render('adminview/tables/category', {
      layout: adminLayouts,
      category,
      gamesEnabled: settings.gamesEnabled !== false,
      query: req.query,
      csrfToken: req.csrfToken ? req.csrfToken() : '',
    });
  } catch (error) {
    console.log(error);
  }
}];

// Games is a feature toggle, not a real product-tagging category — it has no
// name/edit/delete, just on/off, backed by SiteSettings rather than a
// Category document.
exports.toggleGames = [authenticateAdminUser, async (req, res) => {
  try {
    const settings = await SiteSettings.getSettings();
    settings.gamesEnabled = !settings.gamesEnabled;
    await settings.save();
    clearGamesCache();
    res.json({ success: true, gamesEnabled: settings.gamesEnabled });
  } catch (error) {
    console.log(error);
    res.json({ success: false, error: error.message });
  }
}];

exports.createCategory = [authenticateAdminUser, (req, res) => {
  res.redirect('/admin/category/view-category?locked=1');
}];

exports.createCategoryPost = [authenticateAdminUser, async (req, res) => {
  try {
    const { category_name } = req.body;
    if (!category_name || !category_name.trim()) {
      return res.redirect('/admin/category/create-category?error=1');
    }
    await Category.create({ category_name: category_name.trim().toUpperCase() });
    res.redirect('/admin/category/view-category?added=1');
  } catch (error) {
    console.log(error);
    res.redirect('/admin/category/create-category?error=1');
  }
}];

exports.editCategory = [authenticateAdminUser, async (req, res) => {
  try {
    const { category_name } = req.body;
    if (!category_name || !category_name.trim()) {
      return res.json({ success: false, error: 'Category name is required.' });
    }
    const cat = await Category.findByIdAndUpdate(
      req.params.id,
      { category_name: category_name.trim().toUpperCase() },
      { new: true }
    );
    if (!cat) return res.json({ success: false, error: 'Category not found.' });
    res.json({ success: true, category_name: cat.category_name });
  } catch (error) {
    console.log(error);
    res.json({ success: false, error: error.message });
  }
}];

exports.deleteCategory = [authenticateAdminUser, async (req, res) => {
  try {
    const cat = await Category.findByIdAndUpdate(
      req.params.id,
      { is_deleted: 1 },
      { new: true }
    );
    if (!cat) return res.json({ success: false, error: 'Category not found.' });
    res.json({ success: true });
  } catch (error) {
    console.log(error);
    res.json({ success: false, error: error.message });
  }
}];
