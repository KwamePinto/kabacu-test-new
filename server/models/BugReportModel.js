const mongoose = require('mongoose');

/**
 * A bug report raised by an admin from inside the panel.
 *
 * The reporter is stored by id AND by name/role as they were at the time. The
 * id is the real link; the copied name is what the list renders. Keeping both
 * means a report still reads correctly after the reporter is renamed, changes
 * role, or is removed altogether — a report is an audit record of something
 * that was observed, so it should not lose its author.
 */
const bugReportSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true },

  /**
   * Which half of the product the bug is in. The two surfaces are maintained
   * separately, so this is the first thing that decides who picks the report up.
   */
  side: {
    type: String,
    required: true,
    enum: ['client', 'admin'],
  },

  // Free text rather than a fixed list: an admin should be able to name a page
  // that a dropdown written today would not know about.
  page: { type: String, required: true, trim: true },

  description: { type: String, required: true, trim: true },

  /**
   * Triage state. A report starts `open`; the dev moves it along. Lower admins
   * see the status of their own reports so they know they were not shouting
   * into a void.
   */
  status: {
    type: String,
    enum: ['open', 'in-progress', 'resolved', 'wont-fix'],
    default: 'open',
  },

  severity: {
    type: String,
    enum: ['low', 'medium', 'high'],
    default: 'medium',
  },

  // ── Reporter, denormalised on purpose (see the note above) ────────────────
  reportedBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'userAdmin', required: true },
  reporterName:   { type: String, trim: true, default: '' },
  reporterRole:   { type: String, trim: true, default: '' },

  // Set when a super admin closes it out.
  resolutionNote: { type: String, trim: true, default: '' },
  resolvedAt:     { type: Date, default: null },
  resolvedByName: { type: String, trim: true, default: '' },
}, { timestamps: true });

/* The two lists this collection has to serve: every report newest-first for a
   super admin, and one reporter's own reports newest-first for everybody else. */
bugReportSchema.index({ createdAt: -1 });
bugReportSchema.index({ reportedBy: 1, createdAt: -1 });

module.exports = mongoose.model('BugReport', bugReportSchema);
