const mongoose = require('mongoose');

/**
 * A bug report raised by an admin from inside the panel.
 *
 * The reporter and the assigned developer are both stored by id AND by a
 * name/email snapshot as they were at the time. The id is the real link; the
 * copied fields are what the list and the reminder email actually use. That
 * way a report still reads correctly, and a reminder still has somewhere to
 * send to, even after the reporter is renamed or the developer is removed —
 * a report is an audit record of something that was observed, so it should
 * not lose its author or its destination.
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

  severity: {
    type: String,
    enum: ['low', 'medium', 'high'],
    default: 'medium',
  },

  // ── Reporter, denormalised on purpose (see the note above) ────────────────
  reportedBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'userAdmin', required: true },
  reporterName:   { type: String, trim: true, default: '' },
  reporterRole:   { type: String, trim: true, default: '' },

  // ── Assigned developer, denormalised the same way ──────────────────────
  // Required: a report with nowhere to send a reminder is a report nobody
  // is actually accountable for.
  assignedDeveloper:      { type: mongoose.Schema.Types.ObjectId, ref: 'Developer', default: null },
  assignedDeveloperName:  { type: String, trim: true, default: '' },
  assignedDeveloperEmail: { type: String, trim: true, default: '' },

  // Uploaded evidence, attached to the notification (and every reminder) email.
  screenshots: [{
    filename: { type: String, trim: true },   // stored disk name, for the attachment path
    original: { type: String, trim: true },   // what the admin actually uploaded, for display
  }],

  /**
   * A simple toggle, not a workflow — a report is either fixed or it is not.
   * `fixNote` records what was done about it once it is.
   */
  fixed:        { type: Boolean, default: false },
  fixNote:      { type: String, trim: true, default: '' },
  fixedAt:      { type: Date, default: null },
  fixedByName:  { type: String, trim: true, default: '' },

  // Every send is recorded, so "did the developer actually get told" has an
  // answer beyond "the button was clicked once".
  lastRemindedAt: { type: Date, default: null },
}, { timestamps: true });

/* The two lists this collection has to serve: every report newest-first for a
   super admin, and one reporter's own reports newest-first for everybody else. */
bugReportSchema.index({ createdAt: -1 });
bugReportSchema.index({ reportedBy: 1, createdAt: -1 });

module.exports = mongoose.model('BugReport', bugReportSchema);
