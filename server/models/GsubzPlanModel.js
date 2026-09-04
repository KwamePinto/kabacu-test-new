const mongoose = require('mongoose');

/**
 * A GSubz Data Plan — the GSubz-side counterpart to NetworkModel.js.
 *
 *   name       admin's brand label as it appears on products, e.g. "MTN SME Special"
 *   carrier    MTN / GLO / AIRTEL / 9MOBILE
 *   category   which of that carrier's GSubz categories this routes through
 *              (e.g. 'sme', 'gifting', 'datashare', 'data') — the exact set
 *              varies per carrier, see gsubz.js's GSUBZ_CARRIER_CATEGORIES
 *   serviceID  GSubz's own string ID for carrier+category (e.g. "mtn_sme"),
 *              always looked up from GSUBZ_CARRIER_CATEGORIES at save time —
 *              GSubz has no discovery endpoint, so this is never free-typed
 *              by an admin, only ever selected from the confirmed-live set
 *
 * Like NetworkModel, the provider's per-bundle-size plan code deliberately
 * does NOT live here — it stays per product in dataDetails.gsubz_plan_code,
 * since one brand plan spans many sizes, each with its own code.
 */
const GsubzPlanSchema = new mongoose.Schema({
  name:       { type: String, required: true, unique: true, trim: true },
  carrier:    { type: String, required: true, enum: ['MTN', 'GLO', 'AIRTEL', '9MOBILE'] },
  category:   { type: String, required: true },
  serviceID:  { type: String, required: true },
  is_deleted: { type: Number, default: 0 },
}, { timestamps: true });

module.exports = mongoose.model('GsubzPlan', GsubzPlanSchema);
