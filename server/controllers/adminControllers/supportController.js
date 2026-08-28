const path = require('path');
const fs = require('fs/promises');
const Developer = require('../../models/DeveloperModel');
const BugReport = require('../../models/BugReportModel');
const UserAdmin = require('../../models/UserAdminModel');
const sendEmail = require('../../utils/emailService');
const { authenticateAdminUser } = require('../../config/authMiddleware');

/**
 * Support & Reports.
 *
 * Three surfaces: the developer roster (super admin adds/removes, everyone
 * reads it to pick who a report is for), a form any admin can file a bug
 * from — assigning it to a developer and attaching screenshots — and the
 * report list, which a super admin can mark fixed/unfixed and nudge with a
 * reminder email.
 */

const SIDES = ['client', 'admin'];
const SEVERITIES = ['low', 'medium', 'high'];

const SIDE_LABEL = { client: 'Client site', admin: 'Admin dashboard' };
const ROLE_LABEL = {
  super_admin: 'Super admin',
  senior_admin: 'Senior admin',
  junior_admin: 'Junior admin',
};

const UPLOADS_DIR = path.join(__dirname, '..', '..', '..', 'public', 'uploads');

function isSuper(req) {
  return req.user.role === 'super_admin';
}

/** A lower admin may act on their own report; a super admin may act on any. */
function canAct(req, report) {
  return isSuper(req) || String(report.reportedBy) === String(req.user.id);
}

/* Report text goes into an HTML email, so it has to be escaped. An admin
   describing a bug in markup — "the <div> overlaps" — would otherwise have
   their description silently eaten by the mail client. */
function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Preserves the reporter's line breaks, which usually carry the repro steps. */
function escMultiline(value) {
  return esc(value).replace(/\r?\n/g, '<br>');
}

/**
 * The notification / reminder email. Both use this — a reminder is exactly
 * the same report, sent again, not a different message — so there is one
 * template rather than two that could drift apart.
 */
function reportEmail(report, { isReminder = false } = {}) {
  const rows = [
    ['Title', esc(report.title)],
    ['Side', esc(SIDE_LABEL[report.side] || report.side)],
    ['Page', esc(report.page)],
    ['Severity', esc(report.severity)],
    ['Status', report.fixed ? 'Fixed' : 'Unfixed'],
    ['Reported by', esc(report.reporterName) + ' (' + esc(ROLE_LABEL[report.reporterRole] || report.reporterRole) + ')'],
    ['Submitted', esc(new Date(report.createdAt).toUTCString())],
    ['Report ID', esc(String(report._id))],
  ];

  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:24px;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1a1d21;">
  <table role="presentation" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #e6e8eb;">
    <tr>
      <td style="background:${isReminder ? '#b7791f' : '#15a844'};padding:18px 24px;">
        <div style="color:#ffffff;font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.85;">Kabacu &middot; ${isReminder ? 'Reminder' : 'Bug report'}</div>
        <div style="color:#ffffff;font-size:18px;font-weight:700;margin-top:4px;">${esc(report.title)}</div>
      </td>
    </tr>
    <tr>
      <td style="padding:20px 24px 4px;">
        <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;font-size:14px;border-collapse:collapse;">
          ${rows.map(([k, v]) => `<tr>
            <td style="padding:7px 0;color:#6b7280;width:130px;vertical-align:top;">${k}</td>
            <td style="padding:7px 0;font-weight:600;">${v}</td>
          </tr>`).join('')}
        </table>
      </td>
    </tr>
    <tr>
      <td style="padding:12px 24px 24px;">
        <div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#6b7280;margin-bottom:8px;">Description</div>
        <div style="background:#f9fafb;border:1px solid #e6e8eb;border-left:3px solid #15a844;border-radius:6px;padding:14px 16px;font-size:14px;line-height:1.6;">
          ${escMultiline(report.description)}
        </div>
        ${report.screenshots && report.screenshots.length
          ? `<div style="font-size:12.5px;color:#6b7280;margin-top:10px;">${report.screenshots.length} screenshot${report.screenshots.length === 1 ? '' : 's'} attached.</div>`
          : ''}
      </td>
    </tr>
    <tr>
      <td style="padding:0 24px 24px;">
        <div style="font-size:12.5px;color:#6b7280;line-height:1.6;">
          Filed from the Kabacu admin dashboard under Support &amp; Reports, assigned to you.
          ${report.reporterEmail
            ? `Reply to <a href="mailto:${esc(report.reporterEmail)}" style="color:#15a844;">${esc(report.reporterEmail)}</a> if you need the steps to reproduce it.`
            : 'No reply address was on file for the reporter.'}
        </div>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function reportText(report, { isReminder = false } = {}) {
  return [
    isReminder ? 'Kabacu bug report — REMINDER' : 'Kabacu bug report',
    '',
    'Title:       ' + report.title,
    'Side:        ' + (SIDE_LABEL[report.side] || report.side),
    'Page:        ' + report.page,
    'Severity:    ' + report.severity,
    'Status:      ' + (report.fixed ? 'Fixed' : 'Unfixed'),
    'Reported by: ' + report.reporterName + ' (' + report.reporterRole + ')',
    'Submitted:   ' + new Date(report.createdAt).toUTCString(),
    'Report ID:   ' + report._id,
    '',
    'Description',
    '-----------',
    report.description,
  ].join('\n');
}

/** Screenshot rows -> nodemailer attachments, reading the files back off disk. */
function attachmentsFor(report) {
  return (report.screenshots || []).map((s) => ({
    filename: s.original || s.filename,
    path: path.join(UPLOADS_DIR, s.filename),
  }));
}

/* Multer writes uploaded files to disk before the route handler runs, so any
   validation failure in createReport — a missing title, an unassigned
   developer, a non-image file — would otherwise leave the upload orphaned on
   disk with no report ever pointing at it. Called on every early return. */
async function cleanupUploads(files) {
  await Promise.all((files || []).map((f) =>
    fs.unlink(f.path).catch(() => {})));
}

/* ── Panel ──────────────────────────────────────────────────────────────── */

exports.viewPanel = [authenticateAdminUser, async (req, res) => {
  try {
    const [developers, activeDevelopers] = await Promise.all([
      Developer.find().sort({ isActive: -1, createdAt: 1 }).lean(),
      Developer.find({ isActive: true }).sort({ createdAt: 1 }).select('name email').lean(),
    ]);

    const scope = isSuper(req) ? {} : { reportedBy: req.user.id };
    const reports = await BugReport.find(scope).sort({ createdAt: -1 }).limit(200).lean();

    res.render('adminview/support', {
      layout: 'layouts/adminLayout',
      developers,
      activeDevelopers,
      reports,
      isSuperAdmin: isSuper(req),
      myId: String(req.user.id),
      csrfToken: res.locals.csrfToken,
    });
  } catch (err) {
    console.error('[support viewPanel]', err);
    res.render('adminview/support', {
      layout: 'layouts/adminLayout',
      developers: [], activeDevelopers: [], reports: [],
      isSuperAdmin: isSuper(req),
      myId: String(req.user.id),
      csrfToken: res.locals.csrfToken,
    });
  }
}];

/* ── Developers (super admin only) ──────────────────────────────────────── */

exports.addDeveloper = [authenticateAdminUser, async (req, res) => {
  try {
    if (!isSuper(req)) {
      return res.status(403).json({ success: false, message: 'Only a super admin can add a developer.' });
    }

    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim();
    if (!name) return res.json({ success: false, message: 'A name is required.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      return res.json({ success: false, message: 'Enter a valid email address.' });
    }

    const dev = await Developer.create({
      name, email,
      role: String(req.body.role || '').trim(),
      phone: String(req.body.phone || '').trim(),
      notes: String(req.body.notes || '').trim(),
      addedByName: req.user.username || '',
    });

    res.json({ success: true, message: name + ' added.', developer: dev });
  } catch (err) {
    console.error('[support addDeveloper]', err);
    res.json({ success: false, message: 'Server error. Please try again.' });
  }
}];

exports.removeDeveloper = [authenticateAdminUser, async (req, res) => {
  try {
    if (!isSuper(req)) {
      return res.status(403).json({ success: false, message: 'Only a super admin can remove a developer.' });
    }
    const dev = await Developer.findByIdAndDelete(req.params.id);
    if (!dev) return res.json({ success: false, message: 'Developer not found.' });

    /* Reports already assigned to them keep working — their name and email
       were snapshotted onto the report at assignment time (see createReport),
       so a past report's display and its Remind button are unaffected by
       this. Only new assignments stop offering them. */
    res.json({ success: true, message: dev.name + ' removed.' });
  } catch (err) {
    console.error('[support removeDeveloper]', err);
    res.json({ success: false, message: 'Server error. Please try again.' });
  }
}];

/* ── Create a report (any admin) ────────────────────────────────────────── */

exports.createReport = [authenticateAdminUser, async (req, res) => {
  const files = req.files || [];
  try {
    const title = String(req.body.title || '').trim();
    const side = String(req.body.side || '').trim();
    const page = String(req.body.page || '').trim();
    const description = String(req.body.description || '').trim();
    const severity = SEVERITIES.includes(req.body.severity) ? req.body.severity : 'medium';
    const assignedId = String(req.body.assignedDeveloper || '').trim();

    if (!title || !page || !description) {
      await cleanupUploads(files);
      return res.json({ success: false, message: 'Title, page, and description are all required.' });
    }
    if (!SIDES.includes(side)) {
      await cleanupUploads(files);
      return res.json({ success: false, message: 'Choose whether the bug is on the client site or the admin dashboard.' });
    }

    const developer = assignedId ? await Developer.findOne({ _id: assignedId, isActive: true }).lean() : null;
    if (!developer) {
      await cleanupUploads(files);
      return res.json({ success: false, message: 'Choose which developer this report is for.' });
    }

    // Images only — a screenshot is a picture of the problem, not an arbitrary
    // attachment. Multer itself does not filter by type (see config/multer.js,
    // shared by other upload routes with different needs), so that check
    // happens here instead.
    const nonImage = files.find((f) => !/^image\//.test(f.mimetype));
    if (nonImage) {
      await cleanupUploads(files);
      return res.json({ success: false, message: nonImage.originalname + ' is not an image. Screenshots only.' });
    }

    const report = await BugReport.create({
      title, side, page, description, severity,
      reportedBy: req.user.id,
      reporterName: req.user.username || '',
      reporterRole: req.user.role || '',
      assignedDeveloper: developer._id,
      assignedDeveloperName: developer.name,
      assignedDeveloperEmail: developer.email,
      screenshots: files.map((f) => ({ filename: f.filename, original: f.originalname })),
    });

    let emailed = false;
    let emailError = '';
    try {
      const payload = report.toObject();
      /* Not stored on the report — only used to render a reply-to hint. Read
         from the database, not req.user: the admin token carries only id,
         username and role. */
      const reporter = await UserAdmin.findById(req.user.id).select('email').lean();
      payload.reporterEmail = (reporter && reporter.email) || '';

      await sendEmail({
        to: developer.email,
        subject: `[Kabacu ${SIDE_LABEL[side]}] ${title}`,
        html: reportEmail(payload),
        text: reportText(payload),
        attachments: attachmentsFor(report),
      });
      emailed = true;
    } catch (mailErr) {
      console.error('[support createReport mail]', String(report._id), mailErr);
      emailError = mailErr.message || 'unknown error';
    }

    res.json({
      success: true,
      emailed,
      message: emailed
        ? `Report submitted and sent to ${developer.name}.`
        : 'Report saved, but the notification email could not be sent. It is still on record — use Remind once the issue is fixed, or tell the developer directly if it is urgent.',
      emailError,
      reportId: String(report._id),
    });
  } catch (err) {
    console.error('[support createReport]', err);
    await cleanupUploads(files);
    res.json({ success: false, message: 'Server error. Please try again.' });
  }
}];

/* ── Triage (super admin only) ──────────────────────────────────────────── */

exports.updateReport = [authenticateAdminUser, async (req, res) => {
  try {
    if (!isSuper(req)) {
      return res.status(403).json({ success: false, message: 'Only a super admin can update a report.' });
    }

    const report = await BugReport.findById(req.params.id);
    if (!report) return res.json({ success: false, message: 'Report not found.' });

    const fixed = req.body.fixed === true || req.body.fixed === 'true';
    report.fixed = fixed;
    report.fixNote = String(req.body.fixNote || '').trim();
    report.fixedAt = fixed ? new Date() : null;
    report.fixedByName = fixed ? (req.user.username || '') : '';

    // Reassignment is optional on the same form — only touched when a real
    // choice comes through, so leaving it blank never wipes a report's owner.
    const reassignId = String(req.body.assignedDeveloper || '').trim();
    if (reassignId && reassignId !== String(report.assignedDeveloper || '')) {
      const developer = await Developer.findOne({ _id: reassignId, isActive: true }).lean();
      if (!developer) return res.json({ success: false, message: 'Choose an active developer.' });
      report.assignedDeveloper = developer._id;
      report.assignedDeveloperName = developer.name;
      report.assignedDeveloperEmail = developer.email;
    }

    await report.save();
    res.json({ success: true, message: 'Report updated.' });
  } catch (err) {
    console.error('[support updateReport]', err);
    res.json({ success: false, message: 'Server error. Please try again.' });
  }
}];

/**
 * Resend the notification to whoever the report is assigned to right now.
 *
 * Open to the reporter as well as a super admin — nudging a developer about
 * something you personally reported is not a privileged action, it is the
 * whole reason to file it in the first place.
 */
exports.remindReport = [authenticateAdminUser, async (req, res) => {
  try {
    const report = await BugReport.findById(req.params.id);
    if (!report) return res.json({ success: false, message: 'Report not found.' });
    if (!canAct(req, report)) {
      return res.status(403).json({ success: false, message: 'You can only remind about your own reports.' });
    }
    if (!report.assignedDeveloperEmail) {
      return res.json({ success: false, message: 'This report has no developer assigned.' });
    }

    const payload = report.toObject();
    const reporter = await UserAdmin.findById(report.reportedBy).select('email').lean();
    payload.reporterEmail = (reporter && reporter.email) || '';

    await sendEmail({
      to: report.assignedDeveloperEmail,
      subject: `[Kabacu ${SIDE_LABEL[report.side]}] Reminder: ${report.title}`,
      html: reportEmail(payload, { isReminder: true }),
      text: reportText(payload, { isReminder: true }),
      attachments: attachmentsFor(report),
    });

    report.lastRemindedAt = new Date();
    await report.save();

    res.json({ success: true, message: 'Reminder sent to ' + report.assignedDeveloperName + '.' });
  } catch (err) {
    console.error('[support remindReport]', err);
    res.json({ success: false, message: 'Could not send the reminder. Please try again.' });
  }
}];

exports.deleteReport = [authenticateAdminUser, async (req, res) => {
  try {
    if (!isSuper(req)) {
      return res.status(403).json({ success: false, message: 'Only a super admin can delete a report.' });
    }
    const report = await BugReport.findByIdAndDelete(req.params.id);
    if (!report) return res.json({ success: false, message: 'Report not found.' });
    res.json({ success: true, message: 'Report deleted.' });
  } catch (err) {
    console.error('[support deleteReport]', err);
    res.json({ success: false, message: 'Server error. Please try again.' });
  }
}];
