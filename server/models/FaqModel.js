const mongoose = require('mongoose');

const faqSchema = new mongoose.Schema({
  question: { type: String, required: true, trim: true },
  answer:   { type: String, required: true },
  category: {
    type: String,
    required: true,
    // 'admin-dashboard' is the panel manual. It is the only category with
    // audience 'admin', and it is never served to the public FAQ page.
    enum: ['getting-started', 'wallet', 'data', 'courses', 'account', 'rewards', 'admin-dashboard'],
  },

  /**
   * Who the entry is written for.
   *
   * The public FAQ page must filter on this, and it has to be filtered with
   * `{ audience: { $ne: 'admin' } }` rather than `{ audience: 'user' }` —
   * every FAQ that existed before this field was added has no `audience` at
   * all, and an equality match does not match a missing field. `$ne` does, so
   * old entries keep showing up where they always did.
   */
  audience: {
    type: String,
    enum: ['user', 'admin'],
    default: 'user',
  },

  /**
   * For an action only some roles can perform. Rendered as a callout on the
   * entry rather than buried in the answer text, so an admin reading the manual
   * can see at a glance that a step will not be available to them.
   */
  roleNote: {
    type: String,
    enum: ['', 'super_admin', 'senior_admin', 'junior_admin'],
    default: '',
  },

  order:    { type: Number, default: 0 },
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

faqSchema.index({ category: 1, order: 1 });
// The public page reads by audience; the admin manual reads one category.
faqSchema.index({ audience: 1, isActive: 1, order: 1 });

module.exports = mongoose.model('Faq', faqSchema);
