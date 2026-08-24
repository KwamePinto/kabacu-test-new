/**
 * TEMPORARY — "Temp" admin tab holding the short-delivery audit.
 *
 * Built for a one-off review with management. See TEMP-AUDIT-REMOVAL.md for
 * the removal steps; nothing else in the app depends on this file.
 */
const TempShortDelivery = require('../../models/TempShortDeliveryModel');
const { runAudit } = require('../../services/shortDeliveryAudit');
const { authenticateAdminUser } = require('../../config/authMiddleware');

exports.viewPanel = [authenticateAdminUser, async (req, res) => {
  try {
    const snapshot = await TempShortDelivery.findOne().sort({ generatedAt: -1 }).lean();
    res.render('adminview/temp', {
      layout: 'layouts/adminLayout',
      snapshot,
      csrfToken: res.locals.csrfToken,
    });
  } catch (err) {
    console.error('[tempAudit viewPanel]', err);
    res.render('adminview/temp', {
      layout: 'layouts/adminLayout',
      snapshot: null,
      csrfToken: res.locals.csrfToken,
    });
  }
}];

/**
 * Runs the audit and stores a snapshot. Takes roughly half a minute — it pages
 * through the whole OurDataStore transaction history — so it is deliberately
 * manual rather than running on page load.
 */
exports.runAudit = [authenticateAdminUser, async (req, res) => {
  try {
    const result = await runAudit();

    const doc = await TempShortDelivery.create({
      generatedAt: result.generatedAt,
      generatedBy: (req.user && req.user.username) || 'admin',
      rows: result.short,
      totals: result.totals,
      stats: result.stats,
    });

    res.json({
      success: true,
      message: `Audit complete — ${result.totals.rows} short-delivered transaction(s) found.`,
      totals: result.totals,
      generatedAt: doc.generatedAt,
    });
  } catch (err) {
    console.error('[tempAudit runAudit]', err);
    res.json({ success: false, message: `Audit failed: ${err.message}` });
  }
}];

/** CSV export, for pasting into a deck or spreadsheet. */
exports.exportCsv = [authenticateAdminUser, async (req, res) => {
  try {
    const snap = await TempShortDelivery.findOne().sort({ generatedAt: -1 }).lean();
    if (!snap) return res.status(404).send('No audit snapshot yet.');

    const head = ['Date', 'Transaction ID', 'Reference', 'User', 'Phone',
                  'Plan', 'Bought (GB)', 'Delivered (GB)', 'Missing (GB)',
                  'Legs OK', 'Legs Total', 'Amount Paid', 'Value Not Delivered'];
    const lines = [head.join(',')];

    (snap.rows || []).forEach(r => {
      lines.push([
        new Date(r.date).toISOString().slice(0, 16).replace('T', ' '),
        r.transid, r.reference, `"${r.username || ''}"`, r.phone,
        `"${r.planType || ''}"`, r.boughtGb, r.deliveredGb, r.missingGb,
        r.legsOk, r.legs, r.amountPaid, r.lostValue,
      ].join(','));
    });

    lines.push('');
    lines.push(`TOTAL,,,,,,,,${snap.totals.missingGb},,,${snap.totals.paidOnAffected},${snap.totals.lostValue}`);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="short-delivery-audit.csv"');
    res.send(lines.join('\n'));
  } catch (err) {
    console.error('[tempAudit exportCsv]', err);
    res.status(500).send('Export failed.');
  }
}];
