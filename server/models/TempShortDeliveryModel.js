const mongoose = require('mongoose');

/**
 * TEMPORARY — stores one snapshot of the short-delivery audit.
 *
 * The audit pages through ~48 OurDataStore API requests, so running it on every
 * page view would be slow and would hammer their API. The admin runs it on
 * demand and the result is cached here for display.
 *
 * Only the most recent snapshot matters; older ones are kept for comparison.
 *
 * See TEMP-AUDIT-REMOVAL.md — this collection can be dropped when the audit is
 * no longer needed.
 */
const tempShortDeliverySchema = new mongoose.Schema({
  generatedAt: { type: Date, default: Date.now },
  generatedBy: { type: String, default: '' },

  // Denormalised rows exactly as presented in the table
  rows: { type: Array, default: [] },

  totals: {
    rows:           { type: Number, default: 0 },
    customers:      { type: Number, default: 0 },
    paidOnAffected: { type: Number, default: 0 },
    missingGb:      { type: Number, default: 0 },
    lostValue:      { type: Number, default: 0 },
  },

  // Coverage figures, so the table is never read as more complete than it is
  stats: {
    ourSuccesses: { type: Number, default: 0 },
    joined:       { type: Number, default: 0 },
    noRequestId:  { type: Number, default: 0 },
    notInOds:     { type: Number, default: 0 },
    singleLeg:    { type: Number, default: 0 },
    splitAllOk:   { type: Number, default: 0 },
    odsRows:      { type: Number, default: 0 },
  },
}, { timestamps: true });

tempShortDeliverySchema.index({ generatedAt: -1 });

module.exports = mongoose.model('TempShortDelivery', tempShortDeliverySchema);
