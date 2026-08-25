const mongoose = require('mongoose');

/**
 * A way to put money into one market's wallet.
 *
 * Scoped by country because the whole point of a country wallet is that funding
 * it uses that market's rails — a Ghanaian user topping up Cedis should never be
 * offered a Nigerian bank transfer. Existing rows predate country wallets and
 * are stamped NG by scripts/seed-country-wallets.js, so the Naira flow that is
 * already running keeps working untouched.
 */
const paymentMethodSchema = new mongoose.Schema({
  name:        { type: String, required: true, trim: true },
  description: { type: String, default: '', trim: true },

  // ISO alpha-2 of the market this method funds. Same canonical form as
  // Product.country and CountryWallet.country.
  country:     { type: String, default: 'NG', uppercase: true, trim: true },

  /**
   * How the money actually arrives.
   *
   *   gateway — a hosted checkout we redirect to. `provider` names the
   *             integration; only PalmPay (Nigeria) is wired up today.
   *   manual  — the user pays out of band (bank transfer, mobile money) and the
   *             top-up is recorded for an admin to confirm. Default, because a
   *             newly added market has no integration on day one.
   */
  kind:        { type: String, enum: ['gateway', 'manual'], default: 'manual' },
  provider:    { type: String, default: '', trim: true },

  // What the user needs in order to pay — account number, mobile money number.
  instructions:{ type: String, default: '', trim: true },

  isActive:    { type: Boolean, default: true },
}, { timestamps: true });

// The user-facing lookup on every wallet page load.
paymentMethodSchema.index({ country: 1, isActive: 1, createdAt: 1 });

module.exports = mongoose.model('PaymentMethod', paymentMethodSchema);
