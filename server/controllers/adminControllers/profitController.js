const { authenticateAdminUser } = require('../../config/authMiddleware');
const Transaction = require('../../models/TransactionModel');

exports.viewReport = [authenticateAdminUser, async (req, res) => {
  try {
    const { from, to } = req.query;

    // Build date range for the selected filter
    const dateFilter = {};
    if (from) dateFilter.$gte = new Date(from + 'T00:00:00.000Z');
    if (to)   dateFilter.$lte = new Date(to   + 'T23:59:59.999Z');

    const rangeMatch = { status: 'success', markup: { $gt: 0 } };
    if (from || to) rangeMatch.createdAt = dateFilter;

    const now          = new Date();
    const startOfDay   = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfWeek  = new Date(startOfDay); startOfWeek.setDate(startOfDay.getDate() - startOfDay.getDay());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    // Run all three queries in parallel
    const [[summary], [quickStats], transactions] = await Promise.all([
      Transaction.aggregate([
        { $match: rangeMatch },
        { $group: {
          _id:          null,
          totalProfit:  { $sum: '$markup' },
          totalRevenue: { $sum: '$amount' },
          count:        { $sum: 1 },
        }},
      ]),
      Transaction.aggregate([
        { $match: { status: 'success', markup: { $gt: 0 } } },
        { $group: {
          _id:     null,
          today:   { $sum: { $cond: [{ $gte: ['$createdAt', startOfDay]   }, '$markup', 0] } },
          week:    { $sum: { $cond: [{ $gte: ['$createdAt', startOfWeek]  }, '$markup', 0] } },
          month:   { $sum: { $cond: [{ $gte: ['$createdAt', startOfMonth] }, '$markup', 0] } },
          allTime: { $sum: '$markup' },
        }},
      ]),
      Transaction.find(rangeMatch)
        .sort({ createdAt: -1 })
        .limit(200)
        .populate('user', 'name email username')
        .populate('product', 'item_name category costPrice dataDetails coursesDetails electronicDetails automobileDetails')
        .lean(),
    ]);

    res.render('adminview/profit', {
      layout:       'layouts/adminLayout',
      summary:      summary   || { totalProfit: 0, totalRevenue: 0, count: 0 },
      quickStats:   quickStats || { today: 0, week: 0, month: 0, allTime: 0 },
      transactions,
      filters:      { from: from || '', to: to || '' },
    });
  } catch (err) {
    console.error('[profitController]', err);
    res.status(500).send('Error loading profit report.');
  }
}];
