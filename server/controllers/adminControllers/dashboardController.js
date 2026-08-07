const Transaction = require('../../models/TransactionModel');
const TopUp       = require('../../models/TopUpModal');
const User        = require('../../models/UserModel');
const Conversion  = require('../../models/ConversionModal');

const adminLayouts = 'layouts/adminLayout';
const { authenticateAdminUser } = require('../../config/authMiddleware');

exports.dashboard = [authenticateAdminUser, async (req, res) => {
    try {
        const now      = new Date();
        const today    = new Date(now); today.setHours(0, 0, 0, 0);
        const thisWeek = new Date(now); thisWeek.setDate(now.getDate() - 7);
        const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const thisYear  = new Date(now.getFullYear(), 0, 1);

        const [
            totalUsers,
            newUsersToday,
            verifiedUsers,
            [revenueStats],
            pendingTopUps,
            completedTopUps,
            totalConversions,
            recentTransactions
        ] = await Promise.all([
            User.countDocuments(),
            User.countDocuments({ createdAt: { $gte: today } }),
            User.countDocuments({ isVerified: true }),
            // Single $facet pass replaces 5 separate aggregations + 1 countDocuments
            Transaction.aggregate([
                { $match: { status: 'success' } },
                { $facet: {
                    total:   [{ $group: { _id: null, sum: { $sum: '$amount' }, count: { $sum: 1 } } }],
                    today:   [{ $match: { createdAt: { $gte: today } } },      { $group: { _id: null, sum: { $sum: '$amount' } } }],
                    week:    [{ $match: { createdAt: { $gte: thisWeek } } },   { $group: { _id: null, sum: { $sum: '$amount' } } }],
                    month:   [{ $match: { createdAt: { $gte: thisMonth } } },  { $group: { _id: null, sum: { $sum: '$amount' } } }],
                    year:    [{ $match: { createdAt: { $gte: thisYear } } },   { $group: { _id: null, sum: { $sum: '$amount' } } }],
                }},
            ]),
            TopUp.countDocuments({ status: 'PENDING' }),
            TopUp.countDocuments({ status: 'COMPLETED' }),
            Conversion.countDocuments(),
            Transaction.find({ status: 'success' })
                .populate('user', 'username email')
                .populate('product', 'item_name category dataDetails costPrice')
                .sort({ createdAt: -1 })
                .limit(10)
                .lean()
        ]);

        res.render('adminview/dashboard', {
            totalUsers,
            newUsersToday,
            verifiedUsers,
            totalRevenue:   revenueStats?.total[0]?.sum   || 0,
            todayRevenue:   revenueStats?.today[0]?.sum   || 0,
            weeklyRevenue:  revenueStats?.week[0]?.sum    || 0,
            monthlyRevenue: revenueStats?.month[0]?.sum   || 0,
            yearlyRevenue:  revenueStats?.year[0]?.sum    || 0,
            totalPurchases: revenueStats?.total[0]?.count || 0,
            pendingTopUps,
            completedTopUps,
            totalConversions,
            recentTransactions,
            layout: adminLayouts
        });
    } catch (error) {
        console.log('DASHBOARD ERROR:', error);
    }
}];