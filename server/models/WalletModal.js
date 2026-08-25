const mongoose = require('mongoose');

const walletSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
   balances: {
    BTT: {
      type: Number,
      default: 0
    },
    RP: {
      type: Number,
      default: 0
    },
     USDT: {
      type: Number,
      default: 0
    },
     NAIRA: {
      type: Number,
      default: 0
    },
  },

  /**
   * Balances for every market other than Nigeria, keyed by ISO alpha-2
   * ("GH" → 10.5). One entry appears the first time money moves in that market.
   *
   * Nigeria deliberately stays in `balances.NAIRA` and is NOT mirrored here.
   * Over a hundred call sites across purchases, refunds, top-ups, conversions
   * and the admin tools read and write `balances.NAIRA` directly; moving it
   * into this map would mean rewriting all of them at once on a live-bound
   * codebase. Instead `server/utils/wallet.js` routes NG to `balances.NAIRA`
   * and everything else here, so the Naira flow is untouched while new markets
   * get the flexible storage. Read balances through that helper, never by
   * reaching into this field.
   */
  countryBalances: {
    type: Map,
    of: Number,
    default: () => new Map(),
  },
}, { timestamps: true });

walletSchema.index({ user: 1 }, { unique: true });

module.exports = mongoose.model('Wallet', walletSchema);
