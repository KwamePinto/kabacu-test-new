const mongoose = require('mongoose');

/**
 * A single announcement. One collection covers all three surfaces so the admin
 * panel can list, reorder and toggle them in one place.
 *
 *  banner — a slide in the home page hero carousel (image + text + CTA)
 *  strip  — a thin text-only bar under the header, optionally counting down
 *  popup  — a card shown once after a user signs in (image + text + CTA)
 */
const announcementSchema = new mongoose.Schema({
  type: {
    type: String,
    required: true,
    enum: ['banner', 'strip', 'popup'],
  },

  // ── Shared ────────────────────────────────────────────────────────────────
  title:    { type: String, trim: true, default: '' },
  isActive: { type: Boolean, default: true },
  order:    { type: Number, default: 0 },

  // ── Banner / popup ────────────────────────────────────────────────────────
  eyebrow:  { type: String, trim: true, default: '' },  // small label above the title
  subtitle: { type: String, trim: true, default: '' },  // supporting line
  caption:  { type: String, trim: true, default: '' },  // desktop caption (banners)
  image:    { type: String, trim: true, default: '' },  // /uploads/... or /assets/...
  ctaLabel: { type: String, trim: true, default: '' },
  ctaLink:  { type: String, trim: true, default: '' },

  // ── Strip ─────────────────────────────────────────────────────────────────
  // Body text. May contain the token {countdown}, which the browser replaces
  // with a live HH:MM:SS ticking down to countdownEndsAt.
  text: { type: String, trim: true, default: '' },

  // When set, a countdown runs to this moment. Once it passes, the strip stops
  // rendering (see isLive below) so expired promos disappear on their own.
  countdownEndsAt: { type: Date, default: null },

  // Strip colours — kept simple so admins don't need CSS knowledge
  background: { type: String, trim: true, default: '#15a844' },
  textColor:  { type: String, trim: true, default: '#ffffff' },
}, { timestamps: true });

announcementSchema.index({ type: 1, isActive: 1, order: 1 });

/** True when the announcement should be shown right now. */
announcementSchema.methods.isLive = function () {
  if (!this.isActive) return false;
  if (this.countdownEndsAt && this.countdownEndsAt.getTime() <= Date.now()) return false;
  return true;
};

/** Same check for plain objects coming back from .lean(). */
announcementSchema.statics.isLive = function (doc) {
  if (!doc || !doc.isActive) return false;
  if (doc.countdownEndsAt && new Date(doc.countdownEndsAt).getTime() <= Date.now()) return false;
  return true;
};

module.exports = mongoose.model('Announcement', announcementSchema);
