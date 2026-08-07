const Network     = require('../../models/NetworkModel');
const { authenticateAdminUser } = require('../../config/authMiddleware');
const adminLayout = 'layouts/adminLayout';

const PROVIDER_LABELS = { 1: 'MTN', 2: 'GLO', 3: 'Airtel', 4: '9mobile' };

exports.viewNetworks = [authenticateAdminUser, async (req, res) => {
  const networks = await Network.find({ is_deleted: { $ne: 1 } }).sort({ apiCode: 1, name: 1 }).lean();
  res.render('adminview/networks', {
    layout: adminLayout,
    networks,
    providerLabels: PROVIDER_LABELS,
    query: req.query,
  });
}];

exports.addNetwork = [authenticateAdminUser, async (req, res) => {
  try {
    const name    = (req.body.name || '').trim();
    const apiCode = parseInt(req.body.apiCode);
    if (!name || ![1, 2, 3, 4].includes(apiCode)) {
      return res.redirect('/admin/networks?error=invalid');
    }
    const exists = await Network.findOne({ name: { $regex: new RegExp(`^${name}$`, 'i') }, is_deleted: { $ne: 1 } });
    if (exists) return res.redirect('/admin/networks?error=duplicate');
    await Network.create({ name, apiCode });
    res.redirect('/admin/networks?added=1');
  } catch (err) {
    console.error('[networksController.addNetwork]', err);
    res.redirect('/admin/networks?error=1');
  }
}];

exports.deleteNetwork = [authenticateAdminUser, async (req, res) => {
  try {
    await Network.findByIdAndUpdate(req.params.id, { is_deleted: 1 });
    res.redirect('/admin/networks?deleted=1');
  } catch (err) {
    res.redirect('/admin/networks?error=1');
  }
}];
