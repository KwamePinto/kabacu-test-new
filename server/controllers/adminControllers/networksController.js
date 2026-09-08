const Network     = require('../../models/NetworkModel');
const GsubzPlan   = require('../../models/GsubzPlanModel');
const { GSUBZ_CARRIER_CATEGORIES, findService, fetchPlans } = require('../../services/gsubz');
const { authenticateAdminUser } = require('../../config/authMiddleware');
const { odsApiCodes } = require('../../utils/carrier');
const adminLayout = 'layouts/adminLayout';

/* Taken from server/utils/carrier.js rather than written out again — this
   file used to keep its own copy with GLO and Airtel swapped, so the Add
   form taught admins the wrong code and the table mislabelled existing
   plans. The code decides which network a purchase is actually sent to. */
const ODS_CARRIERS = odsApiCodes();

exports.viewNetworks = [authenticateAdminUser, async (req, res) => {
  const [networks, gsubzPlans] = await Promise.all([
    Network.find({ is_deleted: { $ne: 1 } }).sort({ apiCode: 1, name: 1 }).lean(),
    GsubzPlan.find({ is_deleted: { $ne: 1 } }).sort({ carrier: 1, name: 1 }).lean(),
  ]);
  res.render('adminview/networks', {
    layout: adminLayout,
    networks,
    gsubzPlans,
    odsCarriers: ODS_CARRIERS,
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

    // A carrier GSubz has not activated on this account has no categories to
    // pick from at all, so the generic "pick a carrier and a category" reply
    // would be actively misleading — the admin did pick one, it just cannot
    // carry a plan yet.
    const carrierCats = GSUBZ_CARRIER_CATEGORIES[carrier];
    if (carrierCats && !carrierCats.length) {
      return res.redirect('/admin/networks?gerror=nocats&gcarrier=' + encodeURIComponent(carrier) + '#gsubz');
    }

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

/* Live bundle catalogue for one configured GSubz plan.
 *
 * The product form needs two values that decide whether a purchase works
 * at all, and both are hostile to hand-typing (gsubz_doc.md §3.4):
 *   value      -> sent back as `plan` on /pay; a wrong one silently
 *                 delivers a different bundle than the product advertises
 *   api_price  -> what /pay actually charges us, and what the amount we
 *                 send must equal; `price` is the higher suggested resale
 *                 figure and using it overstates cost
 * Serving them from the provider means the admin picks "500MB - 7days"
 * and the ids follow, rather than copying digits between two dashboards.
 */
function parseBundle(p) {
  const displayName = String(p.displayName || "").trim();
  // "500MB - 7days" -> size "500MB", validity "7days". Not every name
  // follows it, so treat a miss as "unknown" rather than mangling it.
  const parts = displayName.split(/s*-s*/);
  const size = (parts[0] || "").trim();
  const validity = parts.slice(1).join(" - ").trim();
  const mbMatch = size.match(/([d.]+)s*(GB|MB)/i);
  const mb = mbMatch
    ? parseFloat(mbMatch[1]) * (mbMatch[2].toUpperCase() === "GB" ? 1024 : 1)
    : Number.MAX_SAFE_INTEGER;
  return {
    value: String(p.value),
    displayName,
    size,
    validity,
    // Both are strings on the wire — parse before any arithmetic.
    price: Number(p.price) || 0,
    apiPrice: Number(p.api_price != null ? p.api_price : p.price) || 0,
    _mb: mb,
  };
}

exports.gsubzPlanBundles = [authenticateAdminUser, async (req, res) => {
  try {
    const plan = await GsubzPlan.findOne({
      name: req.query.plan,
      is_deleted: { $ne: 1 },
    }).lean();
    if (!plan) return res.json({ success: false, message: "That plan is no longer configured." });

    const raw = await fetchPlans(plan.serviceID);
    // GSubz returns these unsorted (10GB, 15GB, 1GB, 20GB...), so order
    // them by actual size — the dropdown is unusable otherwise.
    const bundles = raw.map(parseBundle).sort((a, b) => a._mb - b._mb);

    res.json({ success: true, serviceID: plan.serviceID, carrier: plan.carrier, bundles });
  } catch (err) {
    console.error("[networksController.gsubzPlanBundles]", err.message);
    // Never block product creation on GSubz being reachable — the form
    // falls back to manual entry when this fails.
    res.json({ success: false, message: "Could not reach GSubz: " + err.message });
  }
}];
