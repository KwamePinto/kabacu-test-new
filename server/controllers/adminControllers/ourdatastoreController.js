const { authenticateAdminUser } = require('../../config/authMiddleware');
const { getAccountInfo, fetchDataTransactions } = require('../../services/ourdatastore');

const STATUS_OPTIONS = [
  { value: 'ALL', label: 'All' },
  { value: '1',   label: 'Success' },
  { value: '2',   label: 'Fail' },
  { value: '3',   label: 'Processing' },
];

const PLAN_STATUS = {
  1: { label: 'Success',    cls: 'badge-success'  },
  2: { label: 'Fail',       cls: 'badge-danger'   },
  3: { label: 'Processing', cls: 'badge-warning'  },
};

async function loadDashboardData({ page, status, search }) {
  const [info, history] = await Promise.all([
    getAccountInfo(),
    fetchDataTransactions({ page, status, search, perPage: 20 }),
  ]);

  const transactions = (history.data || []).map(t => ({
    ...t,
    statusInfo: PLAN_STATUS[t.plan_status] || { label: 'Unknown', cls: 'badge-secondary' },
  }));

  // The OurDataStore API uses 0-based page numbers internally (sends page-1 to API).
  // Normalise current_page to 1-based so the view's prev/next links work correctly.
  const normalizedPage = (history.current_page != null ? history.current_page + 1 : page);
  const fromRow = history.from != null ? history.from : (page - 1) * 20 + 1;
  const toRow   = history.to   != null ? history.to   : fromRow + transactions.length - 1;

  const pagination = {
    currentPage: normalizedPage,
    lastPage:    history.last_page || 1,
    total:       history.total     || transactions.length,
    from:        fromRow,
    to:          toRow,
  };

  return { accountInfo: info, transactions, pagination };
}

// Renders the page shell instantly — the account cards and transaction table
// are skeletons, filled in by a follow-up call to /admin/ourdatastore/data.
// The old version awaited both OurDataStore calls before rendering anything,
// so a slow/degraded OurDataStore response (which has become common — see
// the 522s surfacing elsewhere in this admin panel) blocked the page from
// appearing at all, not just from showing real numbers.
exports.viewDashboard = [
  authenticateAdminUser,
  (req, res) => {
    const page   = Math.max(1, parseInt(req.query.page)   || 1);
    const status = req.query.status || 'ALL';
    const search = (req.query.search || '').trim();

    res.render('adminview/ourdatastore', {
      layout: 'layouts/adminLayout',
      filters: { status, search, page },
      statusOptions: STATUS_OPTIONS,
      csrfToken: req.csrfToken ? req.csrfToken() : '',
    });
  },
];

exports.fetchData = [
  authenticateAdminUser,
  async (req, res) => {
    const page   = Math.max(1, parseInt(req.query.page)   || 1);
    const status = req.query.status || 'ALL';
    const search = (req.query.search || '').trim();

    try {
      const { accountInfo, transactions, pagination } = await loadDashboardData({ page, status, search });
      res.json({ success: true, accountInfo, transactions, pagination, filters: { status, search } });
    } catch (err) {
      const message = err.message === 'ADEX_ID_STALE'
        ? 'Data service is temporarily unavailable. Please try again in a few minutes.'
        : err.message;
      res.json({ success: false, error: message });
    }
  },
];
