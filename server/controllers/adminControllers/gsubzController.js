const { authenticateAdminUser } = require('../../config/authMiddleware');
const Transaction = require('../../models/TransactionModel');
const Product = require('../../models/ProductsModal');
const { getBalance, verifyTransaction } = require('../../services/gsubz');
const logger = require('../../config/logger');

const PER_PAGE = 20;

const STATUS_OPTIONS = [
  { value: 'ALL',       label: 'All' },
  { value: 'success',   label: 'Success' },
  { value: 'failed',    label: 'Failed' },
  { value: 'pending',   label: 'Pending' },
  { value: 'mismatch',  label: 'Needs review' },
];

const OUR_STATUS = {
  success:  { label: 'Success',  cls: 'badge-success' },
  failed:   { label: 'Failed',   cls: 'badge-danger' },
  refunded: { label: 'Refunded', cls: 'badge-danger' },
  pending:  { label: 'Pending',  cls: 'badge-warning' },
};

/* Compares what we recorded against what GSubz says, and decides how loudly
 * to shout about the difference.
 *
 * This exists because of the OurDataStore pattern the team was bitten by: a
 * purchase that fails on our side but is delivered anyway is invisible in our
 * own records, so the money is gone and nobody knows. The dangerous pairs are
 * the two 'critical' ones below — everything else is either agreement or an
 * absence of evidence.
 *
 * `norecord` deliberately does NOT count against us when we also think the
 * order failed: GSubz never having heard of it is consistent with a request
 * that never arrived, which is the same story our own 'failed' means.
 */
function reconcile(ourStatus, verdict) {
  const ours = String(ourStatus || '').toLowerCase();
  const weThinkItWorked = ours === 'success';
  const weThinkItDidNot = ours === 'failed' || ours === 'refunded';

  if (verdict === 'delivered') {
    if (weThinkItWorked) return { level: 'ok', label: 'Agrees', note: 'Both sides confirm delivery.' };
    if (weThinkItDidNot) {
      return {
        level: 'critical',
        label: 'Delivered, we said failed',
        note: 'GSubz delivered this and charged us, but our record says it failed — so the customer was very likely refunded for data they actually received. Money is out with nothing recorded against it.',
      };
    }
    return { level: 'warn', label: 'Delivered, still pending here', note: 'GSubz confirms delivery — this can safely be marked successful.' };
  }

  if (verdict === 'failed') {
    if (weThinkItWorked) {
      return {
        level: 'critical',
        label: 'We said success, GSubz says failed',
        note: 'We recorded this as delivered and charged the customer, but GSubz reports it failed. The customer is owed either the data or a refund.',
      };
    }
    if (weThinkItDidNot) return { level: 'ok', label: 'Agrees', note: 'Both sides confirm it failed.' };
    return { level: 'warn', label: 'Failed, still pending here', note: 'GSubz confirms failure — refunding is safe.' };
  }

  if (verdict === 'norecord') {
    if (weThinkItWorked) {
      return {
        level: 'critical',
        label: 'No record at GSubz',
        note: 'We recorded a successful purchase but GSubz has never heard of this request. Either it was charged against a different account or our record is wrong — worth checking by hand.',
      };
    }
    return { level: 'ok', label: 'Never reached GSubz', note: 'GSubz has no record, which matches our own failed/pending result — the request most likely never arrived.' };
  }

  return { level: 'inconclusive', label: 'Could not check', note: 'GSubz gave no usable answer. This proves nothing either way; it will be retried.' };
}

function serviceLabel(tx, productsById) {
  const raw = (tx.apiResponse && tx.apiResponse.raw) || {};
  if (raw.serviceName) return raw.serviceName;
  const product = productsById.get(String(tx.product));
  if (product && product.dataDetails) {
    return [product.dataDetails.network, product.dataDetails.plan_type].filter(Boolean).join(' · ');
  }
  return raw.serviceID || '—';
}

async function loadPanel({ page, status, search }) {
  const query = { provider: 'GSUBZ' };

  if (status === 'mismatch') {
    query['apiResponse._gsubzMismatch'] = true;
  } else if (status !== 'ALL') {
    query.status = status === 'failed' ? { $in: ['failed', 'refunded'] } : status;
  }

  if (search) {
    const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    query.$or = [
      { phone: rx },
      { reference: rx },
      { 'apiResponse.requestId': rx },
      { 'apiResponse.raw.transactionID': rx },
    ];
  }

  // Balance is the one figure that must come from GSubz itself; a failure
  // there must not take the whole panel down with it, so it settles
  // separately from the database work.
  const [balanceResult, total, rows, counts] = await Promise.all([
    getBalance().then((b) => ({ ok: true, b })).catch((e) => ({ ok: false, error: e.message })),
    Transaction.countDocuments(query),
    Transaction.find(query).sort({ createdAt: -1 }).skip((page - 1) * PER_PAGE).limit(PER_PAGE).lean(),
    Transaction.aggregate([
      { $match: { provider: 'GSUBZ' } },
      { $group: { _id: '$status', n: { $sum: 1 }, charged: { $sum: '$amount' } } },
    ]),
  ]);

  const productIds = rows.map((r) => r.product).filter(Boolean);
  const products = productIds.length
    ? await Product.find({ _id: { $in: productIds } }).select('dataDetails').lean()
    : [];
  const productsById = new Map(products.map((p) => [String(p._id), p]));

  const mismatchCount = await Transaction.countDocuments({
    provider: 'GSUBZ',
    'apiResponse._gsubzMismatch': true,
  });

  const stats = { total: 0, success: 0, failed: 0, pending: 0, charged: 0, mismatches: mismatchCount };
  counts.forEach((c) => {
    stats.total += c.n;
    stats.charged += c.charged || 0;
    if (c._id === 'success') stats.success += c.n;
    else if (c._id === 'pending') stats.pending += c.n;
    else stats.failed += c.n;
  });

  const transactions = rows.map((tx) => {
    const raw = (tx.apiResponse && tx.apiResponse.raw) || {};
    const stored = tx.apiResponse || {};
    return {
      id: String(tx._id),
      transactionId: raw.transactionID != null ? String(raw.transactionID) : null,
      requestId: stored.requestId || null,
      reference: tx.reference,
      service: serviceLabel(tx, productsById),
      phone: tx.phone,
      amount: tx.amount,
      // What GSubz actually took off our balance, which is not the same as
      // what the customer paid whenever the product carries a markup.
      cost: raw.amountPaid != null ? Number(raw.amountPaid) : null,
      date: tx.createdAt,
      status: OUR_STATUS[String(tx.status).toLowerCase()] || { label: tx.status || 'Unknown', cls: 'badge-secondary' },
      response: raw.api_response || null,
      check: stored._gsubzVerdict
        ? {
            verdict: stored._gsubzVerdict,
            at: stored._gsubzVerifiedAt || null,
            ...reconcile(tx.status, stored._gsubzVerdict),
          }
        : null,
    };
  });

  const lastPage = Math.max(1, Math.ceil(total / PER_PAGE));
  return {
    balance: balanceResult.ok ? balanceResult.b.balance : null,
    balanceError: balanceResult.ok ? null : balanceResult.error,
    stats,
    transactions,
    pagination: {
      currentPage: page,
      lastPage,
      total,
      from: total === 0 ? 0 : (page - 1) * PER_PAGE + 1,
      to: Math.min(page * PER_PAGE, total),
    },
  };
}

// Renders the shell immediately and lets /admin/gsubz/data fill it in, so a
// slow GSubz balance call never blocks the page from appearing — the same
// reasoning ourdatastoreController documents for its own dashboard.
exports.viewDashboard = [
  authenticateAdminUser,
  (req, res) => {
    res.render('adminview/gsubz', {
      layout: 'layouts/adminLayout',
      filters: {
        page: Math.max(1, parseInt(req.query.page) || 1),
        status: req.query.status || 'ALL',
        search: (req.query.search || '').trim(),
      },
      statusOptions: STATUS_OPTIONS,
      csrfToken: req.csrfToken ? req.csrfToken() : '',
    });
  },
];

exports.fetchData = [
  authenticateAdminUser,
  async (req, res) => {
    const filters = {
      page: Math.max(1, parseInt(req.query.page) || 1),
      status: req.query.status || 'ALL',
      search: (req.query.search || '').trim(),
    };
    try {
      const data = await loadPanel(filters);
      res.json({ success: true, filters, ...data });
    } catch (err) {
      logger.error(`[GSUBZ PANEL] ${err.message}`);
      res.json({ success: false, error: err.message });
    }
  },
];

/* Asks GSubz about the transactions currently on screen and stamps the
 * verdicts onto them. Read-and-record only: it never moves money, because
 * the remedy differs per case (mark delivered vs. refund vs. investigate)
 * and that judgement stays with a human. The flags it writes are what the
 * "Needs review" filter and the background sweep both read.
 */
exports.reconcileTransactions = [
  authenticateAdminUser,
  async (req, res) => {
    try {
      const ids = Array.isArray(req.body.ids) ? req.body.ids.slice(0, 50) : [];
      const query = ids.length
        ? { _id: { $in: ids }, provider: 'GSUBZ' }
        : { provider: 'GSUBZ' };

      const rows = await Transaction.find(query).sort({ createdAt: -1 }).limit(50);
      const results = [];

      for (const tx of rows) {
        const requestId = tx.apiResponse && tx.apiResponse.requestId;
        const check = await verifyTransaction(requestId);
        const verdict = check.verdict;
        const outcome = reconcile(tx.status, verdict);

        tx.apiResponse = {
          ...(tx.apiResponse || {}),
          _gsubzVerdict: verdict,
          _gsubzVerifiedAt: new Date().toISOString(),
          _gsubzVerifyCode: check.code || null,
          // Only a decided disagreement counts as a mismatch — an
          // inconclusive check must not raise a flag that reads as a finding.
          _gsubzMismatch: outcome.level === 'critical',
        };
        tx.markModified('apiResponse');
        await tx.save();

        if (outcome.level === 'critical') {
          logger.warn(`[GSUBZ RECONCILE] TX ${tx._id} (${tx.reference}): ${outcome.label} — ours=${tx.status}, gsubz=${verdict}`);
        }

        results.push({ id: String(tx._id), verdict, ...outcome });
      }

      const criticals = results.filter((r) => r.level === 'critical').length;
      res.json({ success: true, checked: results.length, criticals, results });
    } catch (err) {
      logger.error(`[GSUBZ RECONCILE] ${err.message}`);
      res.json({ success: false, error: err.message });
    }
  },
];

// Shared with the background sweep in transactionPoller.js so both sides
// classify a disagreement identically.
exports._reconcile = reconcile;
