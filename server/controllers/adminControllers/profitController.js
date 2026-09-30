const { authenticateAdminUser } = require('../../config/authMiddleware');
const Transaction = require('../../models/TransactionModel');
const Product = require('../../models/ProductsModal');
const Referral = require('../../models/ReferralModel');
const ReferralCommission = require('../../models/ReferralCommissionModel');
const UserModel = require('../../models/UserModel');
const { loadCarrierMaps, carrierOf, carrierLabel } = require('../../utils/carrier');

/* Same category-branching name resolver profit.ejs used to do inline —
   centralised here since both the main table and the product-detail
   endpoint need it. */
function productDisplayName(p) {
  if (!p) return 'Unknown product';
  switch (p.category) {
    case 'DATA':
      return (p.dataDetails && (p.dataDetails.plan_name || p.dataDetails.plan_type)) || 'Data bundle';
    case 'COURSES':
      return (p.coursesDetails && p.coursesDetails.title) || 'Course';
    case 'ELECTRONICS':
      return (p.electronicDetails && p.electronicDetails.itemName) || 'Electronics item';
    case 'AUTOMOBILE':
      return p.automobileDetails
        ? `${p.automobileDetails.brand || ''} ${p.automobileDetails.model || ''}`.trim() || 'Vehicle'
        : 'Vehicle';
    default:
      return p.item_name || p.category || 'Product';
  }
}

/* Admin refunds (apiResponse.adminRefund:true) cover two real, different
   reasons that share one ledger shape — a short-delivery resolution
   (shortDeliveryRefund in damageControlController.js) and a general
   goodwill/damage-control refund (adminRefundDeduction). Both stamp
   refundReason, and only the short-delivery one starts with this exact
   prefix, so splitting on it is what keeps the two buckets from being
   double-counted against the separate short-delivery aggregation this file
   used to run before — that query summed apiResponse._shortRefundAmount off
   the ORIGINAL purchase row, which is the same money as this ledger row's
   `amount`, just read from two different documents. */
const SHORT_DELIVERY_REFUND_PREFIX = 'Short delivery:';

exports.viewReport = [authenticateAdminUser, async (req, res) => {
  try {
    const { from, to } = req.query;

    const dateFilter = {};
    if (from) dateFilter.$gte = new Date(from + 'T00:00:00.000Z');
    if (to)   dateFilter.$lte = new Date(to   + 'T23:59:59.999Z');

    const rangeMatch = { status: 'success', markup: { $gt: 0 } };
    if (from || to) rangeMatch.createdAt = dateFilter;

    const now          = new Date();
    const startOfDay   = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfWeek  = new Date(startOfDay); startOfWeek.setDate(startOfDay.getDate() - startOfDay.getDay());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [
      // ── Profits tab ──────────────────────────────────────────────────
      [summary],
      [quickStats],
      byProvider,
      transactions,
      // ── Product Analytics tab ───────────────────────────────────────
      productStatsRaw,
      // ── Reward Analytics tab ────────────────────────────────────────
      referralRewardRows,
      commissionRows,
      signupBonusRows,
      adminRefundRows,
      shortTopUpAgg,
      [rpAccruedAgg],
      carrierMaps,
    ] = await Promise.all([
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
      Transaction.aggregate([
        { $match: rangeMatch },
        // Transactions older than the `provider` field itself have no value
        // stored for it — but GSubz did not exist yet when they were made,
        // so every one of them really was ODS, not "unattributed".
        { $group: { _id: { $ifNull: ['$provider', 'ODS'] }, profit: { $sum: '$markup' }, revenue: { $sum: '$amount' }, count: { $sum: 1 } } },
        { $sort: { revenue: -1 } },
      ]),
      Transaction.find(rangeMatch)
        .sort({ createdAt: -1 })
        .limit(200)
        .populate('user', 'name email username')
        .populate('product', 'item_name category costPrice dataDetails coursesDetails electronicDetails automobileDetails')
        .lean(),

      // One row per product actually sold — cart-array purchases (products[])
      // are not attributed here, same scope the old single `product` ref
      // population already had.
      Transaction.aggregate([
        { $match: { status: 'success', product: { $ne: null } } },
        { $group: {
          _id:        '$product',
          unitsSold:  { $sum: 1 },
          revenue:    { $sum: '$amount' },
          profit:     { $sum: '$markup' },
          rpPaid:     { $sum: '$rpEarned' },
          shortCount: { $sum: { $cond: [{ $eq: ['$apiResponse._shortDelivered', true] }, 1, 0] } },
        }},
        { $sort: { revenue: -1 } },
        { $limit: 150 },
      ]),

      Referral.aggregate([
        { $match: { status: 'rewarded' } },
        { $group: { _id: '$rewardType', total: { $sum: '$rewardAmount' }, count: { $sum: 1 } } },
        { $sort: { total: -1 } },
      ]),
      ReferralCommission.aggregate([
        { $group: { _id: '$currencyCode', total: { $sum: '$amount' }, count: { $sum: 1 } } },
        { $sort: { total: -1 } },
      ]),
      UserModel.aggregate([
        { $match: { signupBonusPaidAt: { $ne: null } } },
        { $group: { _id: '$signupBonusType', total: { $sum: '$signupBonusAmount' }, count: { $sum: 1 } } },
        { $sort: { total: -1 } },
      ]),
      Transaction.aggregate([
        { $match: { 'apiResponse.adminRefund': true } },
        { $group: {
          _id: {
            $cond: [
              { $regexMatch: { input: { $ifNull: ['$apiResponse.refundReason', ''] }, regex: '^' + SHORT_DELIVERY_REFUND_PREFIX } },
              'shortDelivery',
              'other',
            ],
          },
          total: { $sum: '$amount' },
          count: { $sum: 1 },
        }},
      ]),
      Transaction.aggregate([
        { $match: { 'apiResponse.adminShortDeliveryTopUp': true } },
        { $group: { _id: null, total: { $sum: '$apiResponse.providerCost' }, count: { $sum: 1 } } },
      ]),
      Transaction.aggregate([
        { $match: { status: 'success' } },
        { $group: { _id: null, total: { $sum: '$rpEarned' }, count: { $sum: { $cond: [{ $gt: ['$rpEarned', 0] }, 1, 0] } } } },
      ]),
      loadCarrierMaps(),
    ]);

    // ── Product Analytics: attach names/category/provider/carrier ───────
    const productIds = productStatsRaw.map((r) => r._id).filter(Boolean);
    const products = await Product.find({ _id: { $in: productIds } })
      .select('item_name category costPrice dataDetails coursesDetails electronicDetails automobileDetails')
      .lean();
    const productById = new Map(products.map((p) => [String(p._id), p]));

    const productStats = productStatsRaw.map((r) => {
      const p = productById.get(String(r._id));
      const carrierToken = p && p.category === 'DATA' ? carrierOf(p.dataDetails, carrierMaps) : null;
      // Same backfill-gap reasoning as the Transaction-level grouping above:
      // a DATA product with no stored provider predates GSubz and was ODS.
      const provider = p && p.category === 'DATA' ? (p.dataDetails && p.dataDetails.provider) || 'ODS' : null;
      return {
        id: String(r._id),
        name: productDisplayName(p),
        category: p ? p.category : 'Unknown',
        provider,
        carrier: carrierToken ? carrierLabel(carrierToken) : null,
        unitsSold: r.unitsSold,
        revenue: r.revenue,
        profit: r.profit,
        rpPaid: r.rpPaid,
        shortCount: r.shortCount,
      };
    });

    // ── Reward Analytics: fold rows into named totals ────────────────────
    const adminRefundShort = adminRefundRows.find((r) => r._id === 'shortDelivery') || { total: 0, count: 0 };
    const adminRefundOther = adminRefundRows.find((r) => r._id === 'other') || { total: 0, count: 0 };
    const shortTopUp = shortTopUpAgg || { total: 0, count: 0 };
    const rpAccrued = rpAccruedAgg || { total: 0, count: 0 };

    const referralRewardTotal   = referralRewardRows.reduce((s, r) => s + r.total, 0);
    const commissionTotal       = commissionRows.reduce((s, r) => s + r.total, 0);
    const signupBonusTotal      = signupBonusRows.reduce((s, r) => s + r.total, 0);
    const adminRefundTotal      = adminRefundShort.total + adminRefundOther.total;
    const rewardsGrandTotal     = referralRewardTotal + commissionTotal + signupBonusTotal + adminRefundTotal + shortTopUp.total;

    res.render('adminview/profit', {
      layout: 'layouts/adminLayout',

      // Profits tab
      summary:    summary    || { totalProfit: 0, totalRevenue: 0, count: 0 },
      quickStats: quickStats || { today: 0, week: 0, month: 0, allTime: 0 },
      byProvider,
      transactions,
      filters: { from: from || '', to: to || '' },

      // Product Analytics tab
      productStats,

      // Reward Analytics tab
      rewards: {
        referral:   { rows: referralRewardRows, total: referralRewardTotal },
        commission: { rows: commissionRows, total: commissionTotal },
        signupBonus:{ rows: signupBonusRows, total: signupBonusTotal },
        adminRefund:{ shortDelivery: adminRefundShort, other: adminRefundOther, total: adminRefundTotal },
        shortTopUp,
        rpAccrued,
        grandTotal: rewardsGrandTotal,
      },
    });
  } catch (err) {
    console.error('[profitController]', err);
    res.status(500).send('Error loading analytics.');
  }
}];

/* "View more" on a Product Analytics row — lazy-loaded rather than baked
   into the main table so the page load stays one pass over ~150 products
   instead of also pulling each one's full transaction history up front. */
exports.productDetail = [authenticateAdminUser, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id).lean();
    if (!product) return res.json({ success: false, message: 'Product not found.' });

    const [recentTx, [stats], carrierMaps] = await Promise.all([
      Transaction.find({ product: product._id })
        .sort({ createdAt: -1 })
        .limit(20)
        .populate('user', 'username email')
        .select('amount status createdAt apiResponse.adminRefund apiResponse._shortDelivered apiResponse._shortResolution')
        .lean(),
      Transaction.aggregate([
        { $match: { product: product._id, status: 'success' } },
        { $group: {
          _id: null,
          unitsSold: { $sum: 1 },
          revenue:   { $sum: '$amount' },
          profit:    { $sum: '$markup' },
          rpPaid:    { $sum: '$rpEarned' },
          shortCount:      { $sum: { $cond: [{ $eq: ['$apiResponse._shortDelivered', true] }, 1, 0] } },
          shortRefundTotal:{ $sum: { $ifNull: ['$apiResponse._shortRefundAmount', 0] } },
        }},
      ]),
      loadCarrierMaps(),
    ]);

    const carrierToken = product.category === 'DATA' ? carrierOf(product.dataDetails, carrierMaps) : null;
    const s = stats || { unitsSold: 0, revenue: 0, profit: 0, rpPaid: 0, shortCount: 0, shortRefundTotal: 0 };

    res.json({
      success: true,
      product: {
        name:      productDisplayName(product),
        category:  product.category,
        costPrice: product.costPrice || 0,
        provider:  product.category === 'DATA' ? ((product.dataDetails && product.dataDetails.provider) || 'ODS') : null,
        carrier:   carrierToken ? carrierLabel(carrierToken) : null,
      },
      stats: {
        unitsSold:  s.unitsSold,
        revenue:    s.revenue,
        profit:     s.profit,
        margin:     s.revenue > 0 ? Math.round((s.profit / s.revenue) * 1000) / 10 : 0,
        rpPaid:     s.rpPaid,
        shortCount: s.shortCount,
        shortDeliveryRate: s.unitsSold > 0 ? Math.round((s.shortCount / s.unitsSold) * 1000) / 10 : 0,
        shortRefundTotal:  s.shortRefundTotal,
      },
      recentTransactions: recentTx.map((t) => ({
        date:           t.createdAt,
        buyer:          t.user ? (t.user.username || t.user.email) : 'Unknown',
        amount:         t.amount,
        status:         t.status,
        shortDelivered: !!(t.apiResponse && t.apiResponse._shortDelivered),
      })),
    });
  } catch (err) {
    console.error('[profitController.productDetail]', err);
    res.json({ success: false, message: 'Server error.' });
  }
}];
