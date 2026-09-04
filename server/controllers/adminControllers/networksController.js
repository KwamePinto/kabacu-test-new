const Network     = require('../../models/NetworkModel');
const GsubzPlan   = require('../../models/GsubzPlanModel');
const { GSUBZ_CARRIER_CATEGORIES, findService } = require('../../services/gsubz');
const { authenticateAdminUser } = require('../../config/authMiddleware');
const adminLayout = 'layouts/adminLayout';

const PROVIDER_LABELS = { 1: 'MTN', 2: 'GLO', 3: 'Airtel', 4: '9mobile' };

exports.viewNetworks = [authenticateAdminUser, async (req, res) => {
  const [networks, gsubzPlans] = await Promise.all([
    Network.find({ is_deleted: { $ne: 1 } }).sort({ apiCode: 1, name: 1 }).lean(),
    GsubzPlan.find({ is_deleted: { $ne: 1 } }).sort({ carrier: 1, name: 1 }).lean(),
  ]);
  res.render('adminview/networks', {
    layout: adminLayout,
    networks,
    gsubzPlans,
    providerLabels: PROVIDER_LABELS,
    carrierCategories: GSUBZ_CARRIER_CATEGORIES,
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

exports.addGsubzPlan = [authenticateAdminUser, async (req, res) => {
  try {
    const name     = (req.body.name || '').trim();
    const carrier  = String(req.body.carrier || '').toUpperCase();
    const category = req.body.category || '';

    // serviceID is never accepted from the form — only ever looked up from
    // the registry, so an admin can't type/paste an unverified GSubz ID.
    const service = findService(carrier, category);
    if (!name || !service) {
      return res.redirect('/admin/networks?gerror=invalid#gsubz');
    }

    const exists = await GsubzPlan.findOne({ name: { $regex: new RegExp(`^${name}$`, 'i') }, is_deleted: { $ne: 1 } });
    if (exists) return res.redirect('/admin/networks?gerror=duplicate#gsubz');

    await GsubzPlan.create({ name, carrier, category, serviceID: service.serviceID });
    res.redirect('/admin/networks?gadded=1#gsubz');
  } catch (err) {
    console.error('[networksController.addGsubzPlan]', err);
    res.redirect('/admin/networks?gerror=1#gsubz');
  }
}];

exports.deleteGsubzPlan = [authenticateAdminUser, async (req, res) => {
  try {
    await GsubzPlan.findByIdAndUpdate(req.params.id, { is_deleted: 1 });
    res.redirect('/admin/networks?gdeleted=1#gsubz');
  } catch (err) {
    res.redirect('/admin/networks?gerror=1#gsubz');
  }
}];
