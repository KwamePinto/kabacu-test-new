const mongoose = require('mongoose');

/**
 * A market the platform actually holds money in.
 *
 * Creating one of these is what makes a country "live": it gives every user a
 * balance in that currency, puts the country in the wallet switcher, and
 * decides which payment methods appear when they try to fund it. A country with
 * products but no wallet can be browsed but not bought from; a country with
 * neither shows "coming soon".
 *
 * Nigeria is seeded from the payment methods that already existed, so nothing
 * about the live Naira flow changes — see scripts/seed-country-wallets.js.
 *
 * Payment methods are NOT stored here. They live in their own collection
 * keyed by country (PaymentMethodModel), so the admin CRUD that already
 * manages them keeps working and there is one source of truth.
 */

const countryWalletSchema = new mongoose.Schema({
  // ISO alpha-2, the same canonical form Product.country uses.
  country:  { type: String, required: true, uppercase: true, trim: true, unique: true },

  /**
   * Currency is copied here at creation time rather than looked up on every
   * read. A wallet holding money must keep the currency it was created with
   * even if the lookup table is later edited, and it lets an admin correct the
   * symbol for a market we have no entry for.
   */
  currencyCode:   { type: String, default: '', uppercase: true, trim: true },
  currencySymbol: { type: String, default: '', trim: true },
  currencyName:   { type: String, default: '', trim: true },

  /**
   * Deactivating hides the market from users without destroying balances —
   * the safe way to pull a country, since money may already be sitting in it.
   */
  isActive: { type: Boolean, default: true },

  createdBy: { type: String, default: '' },
}, { timestamps: true });

/** The live markets, in a stable order for the switcher. */
countryWalletSchema.statics.active = function () {
  return this.find({ isActive: true }).sort({ country: 1 }).lean();
};

/** ISO codes of every live market — what the country picker checks against. */
countryWalletSchema.statics.activeCodes = async function () {
  const rows = await this.find({ isActive: true }).select('country').lean();
  return rows.map(r => r.country);
};

module.exports = mongoose.model('CountryWallet', countryWalletSchema);
