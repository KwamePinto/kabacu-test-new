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

exports.viewDashboard = [
  authenticateAdminUser,
  async (req, res) => {
    const page   = Math.max(1, parseInt(req.query.page)   || 1);
    const status = req.query.status || 'ALL';
    const search = (req.query.search || '').trim();

    let accountInfo   = null;
    let transactions  = [];
    let pagination    = {};
    let error         = null;

    try {
      const [info, history] = await Promise.all([
        getAccountInfo(),
        fetchDataTransactions({ page, status, search, perPage: 20 }),
      ]);

      accountInfo  = info;
      transactions = (history.data || []).map(t => ({
        ...t,
        statusInfo: PLAN_STATUS[t.plan_status] || { label: 'Unknown', cls: 'badge-secondary' },
      }));
      pagination = {
        currentPage: history.current_page,
        lastPage:    history.last_page,
        total:       history.total,
        from:        history.from,
        to:          history.to,
      };
    } catch (err) {
      error = err.message === 'ADEX_ID_STALE'
        ? 'Data service is temporarily unavailable. Please try again in a few minutes.'
        : err.message;
    }

    res.render('adminview/ourdatastore', {
      layout: 'layouts/adminLayout',
      accountInfo,
      transactions,
      pagination,
      filters: { status, search },
      statusOptions: STATUS_OPTIONS,
      error,
      csrfToken: req.csrfToken ? req.csrfToken() : '',
    });
  },
];
