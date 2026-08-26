const SupportSettings = require('../../models/SupportSettingsModel');
const BugReport = require('../../models/BugReportModel');
const UserAdmin = require('../../models/UserAdminModel');
const sendEmail = require('../../utils/emailService');
const { authenticateAdminUser } = require('../../config/authMiddleware');

/**
 * Support & Reports.
 *
 * Three surfaces: the developer contact (super admin sets it, everyone reads
 * it), a form any admin can file a bug from, and the report list — your own
 * reports for a lower admin, everybody's for a super admin.
 */

const SIDES = ['client', 'admin'];
const SEVERITIES = ['low', 'medium', 'high'];
const STATUSES = ['open', 'in-progress', 'resolved', 'wont-fix'];

const SIDE_LABEL = { client: 'Client site', admin: 'Admin dashboard' };
const ROLE_LABEL = {
  super_admin: 'Super admin',
  senior_admin: 'Senior admin',
  junior_admin: 'Junior admin',
};

function isSuper(req) {
  return req.user.role === 'super_admin';
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
 * The notification email.
 *
 * Built so the important facts survive a preview pane: the subject carries the
 * side and the title, and the first block is the summary table. Someone reading
 * this on a phone should know what broke and where before scrolling.
 */
function reportEmail(report) {
  const rows = [
    ['Title', esc(report.title)],
    ['Side', esc(SIDE_LABEL[report.side] || report.side)],
    ['Page', esc(report.page)],
    ['Severity', esc(report.severity)],
    ['Reported by', esc(report.reporterName) + ' (' + esc(ROLE_LABEL[report.reporterRole] || report.reporterRole) + ')'],
    ['Submitted', esc(new Date(report.createdAt).toUTCString())],
    ['Report ID', esc(String(report._id))],
  ];

  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:24px;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1a1d21;">
  <table role="presentation" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #e6e8eb;">
    <tr>
      <td style="background:#15a844;padding:18px 24px;">
        <div style="color:#ffffff;font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.85;">Kabacu &middot; Bug report</div>
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
      </td>
    </tr>
    <tr>
      <td style="padding:0 24px 24px;">
        <div style="font-size:12.5px;color:#6b7280;line-height:1.6;">
          Filed from the Kabacu admin dashboard under Support &amp; Reports.
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

/** Plain-text alternative, for clients that will not render the HTML. */
function reportText(report) {
  return [
    'Kabacu bug report',
    '',
    'Title:       ' + report.title,
    'Side:        ' + (SIDE_LABEL[report.side] || report.side),
    'Page:        ' + report.page,
    'Severity:    ' + report.severity,
    'Reported by: ' + report.reporterName + ' (' + report.reporterRole + ')',
    'Submitted:   ' + new Date(report.createdAt).toUTCString(),
    'Report ID:   ' + report._id,
    '',
    'Description',
    '-----------',
    report.description,
  ].join('\n');
}

/* ── Panel ──────────────────────────────────────────────────────────────── */

exports.viewPanel = [authenticateAdminUser, async (req, res) => {
  try {
    const settings = await SupportSettings.getSettings();

    /* A lower admin sees only their own reports. Scoped in the query rather
       than filtered in the view, so their own list is the only thing the page
       ever holds — a template mistake cannot leak somebody else's report. */
    const scope = isSuper(req) ? {} : { reportedBy: req.user.id };
    const reports = await BugReport.find(scope).sort({ createdAt: -1 }).limit(200).lean();

    res.render('adminview/support', {
      layout: 'layouts/adminLayout',
      settings,
      reports,
      isSuperAdmin: isSuper(req),
      myId: String(req.user.id),
      csrfToken: res.locals.csrfToken,
    });
  } catch (err) {
    console.error('[support viewPanel]', err);
    res.render('adminview/support', {
      layout: 'layouts/adminLayout',
      settings: { devName: 'Victor Pinto', devEmail: 'vkpinto1234@gmail.com', devRole: '', devPhone: '', notes: '' },
      reports: [],
      isSuperAdmin: isSuper(req),
      myId: String(req.user.id),
      csrfToken: res.locals.csrfToken,
    });
  }
}];

/* ── Dev contact (super admin only) ─────────────────────────────────────── */

exports.updateDevInfo = [authenticateAdminUser, async (req, res) => {
  try {
    if (!isSuper(req)) {
      return res.status(403).json({ success: false, message: 'Only a super admin can change the developer contact.' });
    }

    const devName = String(req.body.devName || '').trim();
    const devEmail = String(req.body.devEmail || '').trim();

    if (!devName) return res.json({ success: false, message: 'A name is required.' });

    /* Validated because this address is where every future report is sent. A
       typo here does not fail loudly — reports would submit successfully and go
       nowhere, which is the worst way for this to break. */
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(devEmail)) {
      return res.json({ success: false, message: 'Enter a valid email address — new reports are sent to it.' });
    }

    const settings = await SupportSettings.getSettings();
    settings.devName = devName;
    settings.devEmail = devEmail;
    settings.devRole = String(req.body.devRole || '').trim();
    settings.devPhone = String(req.body.devPhone || '').trim();
    settings.notes = String(req.body.notes || '').trim();
    settings.updatedByName = req.user.username || '';
    settings.updatedById = req.user.id;
    await settings.save();

    res.json({ success: true, message: 'Developer contact updated.' });
  } catch (err) {
    console.error('[support updateDevInfo]', err);
    res.json({ success: false, message: 'Server error. Please try again.' });
  }
}];

/* ── Create a report (any admin) ────────────────────────────────────────── */

exports.createReport = [authenticateAdminUser, async (req, res) => {
  try {
    const title = String(req.body.title || '').trim();
    const side = String(req.body.side || '').trim();
    const page = String(req.body.page || '').trim();
    const description = String(req.body.description || '').trim();
    const severity = SEVERITIES.includes(req.body.severity) ? req.body.severity : 'medium';

    if (!title || !page || !description) {
      return res.json({ success: false, message: 'Title, page, and description are all required.' });
    }
    if (!SIDES.includes(side)) {
      return res.json({ success: false, message: 'Choose whether the bug is on the client site or the admin dashboard.' });
    }

    /* Saved before the email is attempted, and the email failure is reported
       separately below. A report is a record of something an admin observed —
       losing it because the mail transport hiccuped would be the wrong
       trade, and they would have no way of knowing to write it again. */
    const report = await BugReport.create({
      title,
      side,
      page,
      description,
      severity,
      reportedBy: req.user.id,
      reporterName: req.user.username || '',
      reporterRole: req.user.role || '',
    });

    const settings = await SupportSettings.getSettings();

    let emailed = false;
    let emailError = '';
    try {
      const payload = report.toObject();

      /* Read from the database, not from req.user: the admin token carries only
         id, username and role, so req.user.email does not exist. Without this
         the reply-to link in the email would be an empty mailto. */
      const reporter = await UserAdmin.findById(req.user.id).select('email').lean();
      payload.reporterEmail = (reporter && reporter.email) || '';

      await sendEmail({
        to: settings.devEmail,
        subject: `[Kabacu ${SIDE_LABEL[side]}] ${title}`,
        html: reportEmail(payload),
        text: reportText(payload),
      });
      emailed = true;
    } catch (mailErr) {
      // Logged with the report id so the two can be tied together afterwards.
      console.error('[support createReport mail]', String(report._id), mailErr);
      emailError = mailErr.message || 'unknown error';
    }

    res.json({
      success: true,
      emailed,
      message: emailed
        ? `Report submitted and sent to ${settings.devName}.`
        : 'Report saved, but the notification email could not be sent. It is still on record — tell the developer directly if it is urgent.',
      emailError,
      reportId: String(report._id),
    });
  } catch (err) {
    console.error('[support createReport]', err);
    res.json({ success: false, message: 'Server error. Please try again.' });
  }
}];

/* ── Triage (super admin only) ──────────────────────────────────────────── */

exports.updateReport = [authenticateAdminUser, async (req, res) => {
  try {
    if (!isSuper(req)) {
      return res.status(403).json({ success: false, message: 'Only a super admin can update a report.' });
    }

    const status = STATUSES.includes(req.body.status) ? req.body.status : null;
    if (!status) return res.json({ success: false, message: 'Unknown status.' });

    const update = {
      status,
      resolutionNote: String(req.body.resolutionNote || '').trim(),
    };

    // Stamped when it reaches a closed state, cleared if it is reopened, so the
    // date always describes the state the report is actually in.
    if (status === 'resolved' || status === 'wont-fix') {
      update.resolvedAt = new Date();
      update.resolvedByName = req.user.username || '';
    } else {
      update.resolvedAt = null;
      update.resolvedByName = '';
    }

    const report = await BugReport.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!report) return res.json({ success: false, message: 'Report not found.' });

    res.json({ success: true, message: 'Report updated.' });
  } catch (err) {
    console.error('[support updateReport]', err);
    res.json({ success: false, message: 'Server error. Please try again.' });
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
