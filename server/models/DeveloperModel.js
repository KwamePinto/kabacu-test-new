const mongoose = require('mongoose');

/**
 * Someone a bug report can be assigned to.
 *
 * A real collection rather than the old single-contact singleton: there can be
 * more than one developer, a super admin adds and removes them as the team
 * changes, and a report is assigned to a specific one rather than always going
 * to "the" contact.
 */
const developerSchema = new mongoose.Schema({
  name:  { type: String, required: true, trim: true },
  email: { type: String, required: true, trim: true },

  // Optional extras; blank ones simply don't render.
  role:  { type: String, trim: true, default: '' },
  phone: { type: String, trim: true, default: '' },
  notes: { type: String, trim: true, default: '' },

  // A removed developer keeps their name off the active list without deleting
  // the reports assigned to them — see BugReport's own name/email snapshot,
  // which is what actually keeps their history readable.
  isActive: { type: Boolean, default: true },

  addedByName: { type: String, trim: true, default: '' },
}, { timestamps: true });

developerSchema.index({ isActive: 1, createdAt: 1 });

module.exports = mongoose.model('Developer', developerSchema);
