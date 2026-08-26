const mongoose = require('mongoose');

/**
 * Who an admin contacts when something is broken.
 *
 * A singleton, like ReferralSettings: there is one development contact for the
 * whole panel, and every admin sees the same one. Kept in the database rather
 * than in code or an env var so a super admin can hand the role over without a
 * deploy — the person on call changes more often than the software does.
 */
const supportSettingsSchema = new mongoose.Schema({
  devName:  { type: String, trim: true, default: 'Victor Pinto' },
  devEmail: { type: String, trim: true, default: 'vkpinto1234@gmail.com' },

  // Optional extras a super admin can fill in; blank ones simply don't render.
  devRole:  { type: String, trim: true, default: 'Lead Developer' },
  devPhone: { type: String, trim: true, default: '' },
  notes:    { type: String, trim: true, default: '' },

  // Who last changed the contact, so a wrong address can be traced back.
  updatedByName: { type: String, trim: true, default: '' },
  updatedById:   { type: mongoose.Schema.Types.ObjectId, ref: 'userAdmin', default: null },
}, { timestamps: true });

/** Always returns the single settings document, creating it on first use. */
supportSettingsSchema.statics.getSettings = async function () {
  let doc = await this.findOne();
  if (!doc) doc = await this.create({});
  return doc;
};

module.exports = mongoose.model('SupportSettings', supportSettingsSchema);
