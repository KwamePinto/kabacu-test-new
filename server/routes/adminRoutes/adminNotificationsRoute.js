const express     = require('express');
const router      = express.Router();
const Transaction = require('../../models/TransactionModel');
const { authenticateAdminUser } = require('../../config/authMiddleware');

// GET /admin/notifications
// Returns recent flagged transactions for the dashboard bell.
router.get('/', authenticateAdminUser, async (req, res) => {
  try {
    const [oldFlagged, newFlagged, odsDamage] = await Promise.all([
      // Case 1 (pre-fix): timed out → treated as fail → wallet refunded → may need deduction
      Transaction.find({
        paymentMethod: 'wallet',
        status: 'failed',
        'apiResponse.status': 'fail',
        'apiResponse.message': { $exists: false },
        'apiResponse.adminDeducted': { $ne: true },
      }).sort({ createdAt: -1 }).limit(20).populate('user', 'username').lean(),

      // Case 2 (post-fix): timed out → saved as pending → wallet deducted → needs verification
      Transaction.find({
        paymentMethod: 'wallet',
        status: 'pending',
        'apiResponse._timedOut': true,
      }).sort({ createdAt: -1 }).limit(20).populate('user', 'username').lean(),

      // Case 4: ODS cross-reference confirmed data was delivered but wallet was refunded
      Transaction.find({
        paymentMethod: 'wallet',
        status: 'failed',
        'apiResponse.odsDelivered': true,
        'apiResponse.adminDeducted': { $ne: true },
      }).sort({ createdAt: -1 }).limit(20).populate('user', 'username').lean(),
    ]);

    const all = [...oldFlagged, ...newFlagged, ...odsDamage]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 15);

    const notifications = all.map(tx => {
      const user   = tx.user?.username || 'Unknown';
      const phone  = tx.phone  || '—';
      const amount = tx.amount ? '₦' + Number(tx.amount).toLocaleString() : '';
      const isOld  = tx.status === 'failed';

      const isOds = tx.apiResponse?.odsDelivered;
      return {
        id:    tx._id,
        text:  isOds
          ? `${user} — ODS confirmed data delivered but wallet was refunded (${phone}, ${amount}). Re-deduct.`
          : isOld
            ? `${user} — wallet refunded after timeout (${phone}, ${amount}). Check if data was delivered.`
            : `${user} — payment timed out (${phone}, ${amount}). Wallet is deducted. Verify delivery.`,
        icon:  'alert-triangle',
        color: isOds ? 'bg-danger' : isOld ? 'bg-danger' : 'bg-warning',
        time:  tx.createdAt,
        link:  '/admin/flagged-transactions',
      };
    });

    res.json({ success: true, notifications, count: notifications.length });
  } catch (err) {
    res.json({ success: false, notifications: [], count: 0 });
  }
});

module.exports = router;
