const { authenticateAdminUser } = require('../../config/authMiddleware');

// Placeholder page — GSubz has been onboarded as a service provider (see
// gsubz_doc.md at the project root for the full API reference and the
// production risks to close before it handles real purchases) but no
// purchasing/config UI has been built yet. This page exists so the nav
// entry has somewhere to go as that work lands incrementally.
exports.viewDashboard = [
  authenticateAdminUser,
  async (req, res) => {
    res.render('adminview/gsubz', {
      layout: 'layouts/adminLayout',
    });
  },
];
