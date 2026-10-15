const mongoose = require('mongoose');

/**
 * One document per toggle-able page (see server/data/managedPages.js for the
 * registry of valid keys). Created lazily — only when an admin actually
 * changes something for that page, via the upsert in pageFlagsController.js
 * — not seeded up front. A page with no document here is simply enabled with
 * no custom coming-soon content; see pageFlagsMiddleware.js::getFlag.
 */
const pageFlagSchema = new mongoose.Schema({
  key: {
    type: String,
    required: true,
    unique: true,
    trim: true,
  },

  enabled: {
    type: Boolean,
    default: true,
  },

  // Shown on the coming-soon page in place of the generic defaults when set
  // — see views/webview/comingSoon.ejs.
  comingSoonTitle:   { type: String, default: '', trim: true },
  comingSoonMessage: { type: String, default: '' },
  comingSoonImage:   { type: String, default: '', trim: true }, // '/uploads/xxx' or a pasted URL
}, { timestamps: true });

module.exports = mongoose.model('PageFlag', pageFlagSchema);
