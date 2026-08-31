const mongoose = require('mongoose');

const siteSettingsSchema = new mongoose.Schema({
  rpTransferEnabled: {
    type: Boolean,
    default: false,
  },
  rpTransferSuspendedMessage: {
    type: String,
    default: 'RP transfer to BitToken has been suspended for the time being. Please check back later.',
  },

  // BTT topup from Bittoken
  bttTopupEnabled: {
    type: Boolean,
    default: true,
  },
  bttTopupSuspendedMessage: {
    type: String,
    default: 'BTT top-up has been temporarily suspended. Please check back later.',
  },

  // USDT topup & conversion from Bittoken
  usdtTopupEnabled: {
    type: Boolean,
    default: true,
  },
  usdtTopupSuspendedMessage: {
    type: String,
    default: 'USDT top-up has been temporarily suspended. Please check back later.',
  },

  // OurDataStore ADEX ID — auto-updated from history response, overridable from admin panel
  ourdatastoreAdexId: {
    type: String,
    default: '',
    trim: true,
  },

  // Maintenance mode
  maintenanceModeEnabled: {
    type: Boolean,
    default: true,
  },
  maintenanceMessage: {
    type: String,
    default: "We're currently performing scheduled maintenance to improve your experience. We'll be back up shortly — thank you for your patience.",
  },

  // Upcoming maintenance banner
  maintenanceBannerEnabled: {
    type: Boolean,
    default: false,
  },
  maintenanceBannerScheduledAt: {
    type: Date,
    default: null,
  },

  // Games arcade (public page fed from GameMonetize) — nav link, category
  // cards, and the page itself all hide when this is off.
  gamesEnabled: {
    type: Boolean,
    default: true,
  },
}, { timestamps: true });

// Singleton helper — always work with the one document
siteSettingsSchema.statics.getSettings = async function () {
  let settings = await this.findOne();
  if (!settings) settings = await this.create({});
  return settings;
};

module.exports = mongoose.model('SiteSettings', siteSettingsSchema);
