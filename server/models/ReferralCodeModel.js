const mongoose = require('mongoose');

/**
 * Every referral code that has ever belonged to a user.
 *
 * ── Why this table exists ───────────────────────────────────────────────────
 * A code used to live in one place: `User.referralCode`, one per account. That
 * made changing a code destructive — the moment a user swapped to a vanity code,
 * every link and screenshot carrying the old one stopped resolving, and anybody
 * part-way through signing up with it hit "that referral code does not exist".
 *
 * Codes are permanent here instead. Changing a code retires the old row and adds
 * a new primary one; the retired row still points at the same user, so an old
 * code keeps crediting the person who earned it, forever. `User.referralCode`
 * survives as a denormalised copy of the primary — it is what the header, the
 * profile and the share button read — but this table is the authority for
 * resolving a code to its owner.
 *
 * ── Three kinds ─────────────────────────────────────────────────────────────
 *   system  KB######## — generated on first access, free
 *   special — an admin-reserved vanity code the user bought from the pool
 *   custom  — a code the user chose themselves and paid for
 *
 * The kind is kept per code, not per user, because it decides the bonuses: a
 * referral arriving on a paid code pays its owner more than one arriving on
 * their free system code, even though both belong to the same person.
 */
const referralCodeSchema = new mongoose.Schema({
  code: {
    type: String,
    required: true,
    unique: true,
    uppercase: true,
    trim: true,
  },

  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'user',
    required: true,
  },

  kind: {
    type: String,
    enum: ['system', 'special', 'custom'],
    default: 'system',
  },

  /**
   * The code shown as "your referral code" and handed out by the share button.
   * Exactly one per user — enforced by a partial unique index below rather than
   * by convention, because two primaries would make "your code" ambiguous.
   *
   * A non-primary row is a retired code: still valid for anyone applying it,
   * just no longer advertised.
   */
  isPrimary: { type: Boolean, default: true },

  /**
   * What the user paid, and the two bonuses it carries, frozen at purchase time.
   *
   * Snapshotted deliberately: an admin changing the programme's bonuses later
   * must not silently re-price a code somebody already bought. The bonus a user
   * was sold is the bonus they keep.
   *
   * The two are independent because they pay out at different moments and carry
   * different risk. The reward bonus lands once, when a referral qualifies, so
   * it is a known one-off cost. The commission bonus applies to every later
   * purchase that referred user makes, so it is an open-ended liability — which
   * is exactly why an admin needs to be able to set it to zero while still
   * paying a generous one-off.
   */
  pricePaid: { type: Number, default: 0, min: 0 },

  // Percent added to the one-off referral reward.
  rewardBonusPercent: { type: Number, default: 0, min: 0 },

  // Percent added to the ongoing per-purchase commission. 0 means a paid code
  // earns the standard commission with no uplift.
  commissionBonusPercent: { type: Number, default: 0, min: 0 },

  // Set for `special` codes so the pool row and this one stay traceable.
  specialCode: { type: mongoose.Schema.Types.ObjectId, ref: 'SpecialReferralCode', default: null },

  // The request that produced it, for paid codes. Null for system codes.
  request: { type: mongoose.Schema.Types.ObjectId, ref: 'ReferralCodeRequest', default: null },

  retiredAt: { type: Date, default: null },
}, { timestamps: true });

referralCodeSchema.index({ user: 1, isPrimary: -1, createdAt: -1 });

/**
 * One primary per user. Partial so the many retired rows are unconstrained —
 * a plain compound unique index would allow only one retired code per user.
 */
referralCodeSchema.index(
  { user: 1, isPrimary: 1 },
  { unique: true, partialFilterExpression: { isPrimary: true } },
);

/** The code a user currently advertises. */
referralCodeSchema.statics.primaryFor = function (userId) {
  return this.findOne({ user: userId, isPrimary: true }).lean();
};

/**
 * Who owns this code — current or retired, both resolve. This is the lookup
 * that keeps an old code working after its owner has moved on to a new one.
 */
referralCodeSchema.statics.ownerOf = function (code) {
  return this.findOne({ code: String(code || '').trim().toUpperCase() });
};

module.exports = mongoose.model('ReferralCode', referralCodeSchema);
