const mongoose = require('mongoose');

/**
 * A Data Plan. Despite the collection name (kept so existing products, which
 * store the plan by name in dataDetails.network, keep resolving) this is a
 * PLAN, not a carrier:
 *
 *   name     the plan as it appears on products, e.g. "CTC Weekly Special-MTN"
 *   apiCode  the underlying carrier it routes through (MTN / GLO / Airtel / 9mobile)
 *
 * NOTE: the provider's bundle id (`data_plan`) deliberately does NOT live here.
 * One plan spans many sizes, each with its own id — "CTC Monthly Special-MTN"
 * alone uses 244/243/4/3/2/240 for 15GB/10GB/5GB/3GB/2GB/1GB. A single id on
 * the plan would deliver the same bundle for every size, so it stays per
 * product in dataDetails.plan_id.
 */
const NetworkSchema = new mongoose.Schema({
  name:       { type: String, required: true, unique: true, trim: true },
  apiCode:    { type: Number, required: true, enum: [1, 2, 3, 4] },
  is_deleted: { type: Number, default: 0 },
}, { timestamps: true });

// Human-readable label for each API code
NetworkSchema.statics.providerLabel = function (code) {
  return { 1: 'MTN', 2: 'GLO', 3: 'Airtel', 4: '9mobile' }[code] || 'Unknown';
};

module.exports = mongoose.model('Network', NetworkSchema);
