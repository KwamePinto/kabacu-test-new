const mongoose = require('mongoose');

/**
 * One row per RP credit pushed in from an external platform (CSkillsHub, and
 * any future one keyed the same way) — not a wallet balance itself, but the
 * event-level ledger that makes the credit auditable and, more importantly,
 * exactly-once.
 *
 * The unique index on (source, reference) is the whole point: it is what
 * stops a retried webhook delivery from crediting the same RP twice. The
 * external platform is expected to send a reference that is unique and
 * stable on ITS side for the specific thing that earned the RP (a course
 * completion id, an enrolment id, etc.) — not something we generate, since
 * the guarantee only holds if the sender re-sends the same reference on a
 * retry rather than minting a new one each time.
 */
const externalRpCreditSchema = new mongoose.Schema({
  source: { type: String, required: true, default: 'cskillshub' },
  // The external platform's own idempotency key for this credit.
  reference: { type: String, required: true },

  user: { type: mongoose.Schema.Types.ObjectId, ref: 'user', required: true },
  email: { type: String, required: true },

  rpAmount: { type: Number, required: true },
  balanceBefore: { type: Number, default: null },
  balanceAfter: { type: Number, default: null },

  // Context only — never required, since not every RP-earning event on the
  // external side is tied to one specific course (e.g. a quiz, a streak).
  courseId: { type: String, default: null },
  courseTitle: { type: String, default: '' },
  reason: { type: String, default: '' },

  // The raw payload the external platform sent, kept for support/debugging —
  // same reasoning as Transaction.apiResponse / TopUp.webhookData elsewhere.
  rawPayload: { type: Object, default: null },
}, { timestamps: true });

externalRpCreditSchema.index({ source: 1, reference: 1 }, { unique: true });
externalRpCreditSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model('ExternalRpCredit', externalRpCreditSchema);
