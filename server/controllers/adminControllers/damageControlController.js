const { authenticateAdminUser } = require('../../config/authMiddleware');
const Transaction     = require('../../models/TransactionModel');
const Wallet          = require('../../models/WalletModal');
const { notify }      = require('../../services/userNotificationService');

// Case 1 (pre-fix): timed out → treated as fail → wallet refunded → may need manual deduction
const OLD_FLAGGED_FILTER = {
  paymentMethod: 'wallet',
  status: 'failed',
  'apiResponse.status': 'fail',
  'apiResponse.message': { $exists: false },
  'apiResponse.adminDeducted': { $ne: true },
  adminCleared: { $ne: true },
};

// Case 2 (post-fix): timed out → saved as pending → wallet is already deducted → needs verification
const NEW_FLAGGED_FILTER = {
  paymentMethod: 'wallet',
  status: 'pending',
  'apiResponse._timedOut': true,
  adminCleared: { $ne: true },
};

// Case 3: timed out → poller refunded wallet after 30 min → status=failed, apiResponse._timedOut still set
// These were invisible because OLD_FLAGGED requires apiResponse.status:'fail' (never set by poller).
const POLLER_FAILED_FILTER = {
  paymentMethod: 'wallet',
  status: 'failed',
  'apiResponse._timedOut': true,
  'apiResponse.adminDeducted': { $ne: true },
  adminCleared: { $ne: true },
};

// Case 4: ODS cross-reference confirmed data was delivered but Kabacu refunded the wallet.
// Marked with odsDelivered:true by the mark-ods-damage.js script.
const ODS_DAMAGE_FILTER = {
  paymentMethod: 'wallet',
  status: 'failed',
  'apiResponse.odsDelivered': true,
  'apiResponse.adminDeducted': { $ne: true },
  adminCleared: { $ne: true },
};

exports.viewDamageControl = [authenticateAdminUser, async (req, res) => {
  try {
    const [oldFlagged, newFlagged, pollerFailed, odsDamage] = await Promise.all([
      Transaction.find(OLD_FLAGGED_FILTER).populate('user', 'username email').sort({ createdAt: -1 }).lean(),
      Transaction.find(NEW_FLAGGED_FILTER).populate('user', 'username email').sort({ createdAt: -1 }).lean(),
      Transaction.find(POLLER_FAILED_FILTER).populate('user', 'username email').sort({ createdAt: -1 }).lean(),
      Transaction.find(ODS_DAMAGE_FILTER).populate('user', 'username email').sort({ createdAt: -1 }).lean(),
    ]);

    // Merge and sort by date descending
    const allFlagged = [...oldFlagged, ...newFlagged, ...pollerFailed, ...odsDamage]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    // Batch retry check — one query for all users instead of one per flagged item
    let rows = allFlagged.map(tx => ({ ...tx, hasSuccessRetry: false }));
    if (allFlagged.length > 0) {
      const since = new Date(Math.min(...allFlagged.map(tx => new Date(tx.createdAt).getTime())));
      const userIds = [...new Set(allFlagged.map(tx => tx.user?._id?.toString() || tx.user?.toString()).filter(Boolean))];
      const recentSuccesses = await Transaction.find({
        user:      { $in: userIds },
        status:    'success',
        createdAt: { $gte: since },
      }).select('user phone amount createdAt').lean();

      const successesByUser = {};
      recentSuccesses.forEach(s => {
        const uid = s.user.toString();
        if (!successesByUser[uid]) successesByUser[uid] = [];
        successesByUser[uid].push(s);
      });

      rows = allFlagged.map(tx => {
        const uid       = tx.user?._id?.toString() || tx.user?.toString();
        const windowEnd = new Date(new Date(tx.createdAt).getTime() + 24 * 60 * 60 * 1000);
        const hasSuccessRetry = (successesByUser[uid] || []).some(s =>
          s.phone === tx.phone &&
          s.amount === tx.amount &&
          new Date(s.createdAt) > new Date(tx.createdAt) &&
          new Date(s.createdAt) < windowEnd
        );
        return { ...tx, hasSuccessRetry };
      });
    }

    const totalAmount = rows.reduce((s, r) => s + (r.amount || 0), 0);

    const [deductedHistory, clearedRows, refundedHistory] = await Promise.all([
      Transaction.find({
        paymentMethod: 'wallet',
        'apiResponse.adminDeducted': true,
        'apiResponse.adminRefunded': { $ne: true },
        'apiResponse.refundPending':  { $ne: true },
      }).populate('user', 'username email').sort({ 'apiResponse.adminDeductedAt': -1 }).lean(),
      Transaction.find({
        adminCleared: true,
        adminClearedAt: { $gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) },
      }).populate('user', 'username email').sort({ adminClearedAt: -1 }).limit(500).lean(),
      Transaction.find({
        paymentMethod: 'wallet',
        'apiResponse.adminDeducted': true,
        $or: [
          { 'apiResponse.adminRefunded': true },
          { 'apiResponse.refundPending': true },
        ],
      }).populate('user', 'username email').sort({ createdAt: -1 }).lean(),
    ]);

    const alreadyDeducted = deductedHistory.length;

    res.render('adminview/flagged-transactions', {
      layout: 'layouts/adminLayout',
      rows,
      totalAmount,
      alreadyDeducted,
      deductedHistory,
      clearedRows,
      refundedHistory,
    });
  } catch (err) {
    console.error('[damageControl]', err);
    res.render('adminview/flagged-transactions', {
      layout: 'layouts/adminLayout',
      rows: [],
      totalAmount: 0,
      alreadyDeducted: 0,
      deductedHistory: [],
      clearedRows: [],
      refundedHistory: [],
      error: 'Failed to load data',
    });
  }
}];

// POST /deduct
// Case 1 (old): status=failed, wallet was refunded — deduct it now if data was delivered.
exports.deductWallet = [authenticateAdminUser, async (req, res) => {
  try {
    const { transactionId } = req.body;

    const tx = await Transaction.findById(transactionId);
    if (!tx)                        return res.json({ success: false, message: 'Transaction not found' });
    if (tx.status !== 'failed')     return res.json({ success: false, message: 'Only failed transactions can be manually deducted' });
    if (tx.apiResponse?.adminDeducted) return res.json({ success: false, message: 'Already deducted' });

    const wallet = await Wallet.findOne({ user: tx.user });
    if (!wallet) return res.json({ success: false, message: 'User wallet not found' });

    const before = wallet.balances.NAIRA;
    wallet.balances.NAIRA -= tx.amount;
    await wallet.save();

    tx.balanceBefore = before;
    tx.balanceAfter  = wallet.balances.NAIRA;
    tx.apiResponse = {
      status: 'fail',
      adminDeducted: true,
      adminDeductedAt: new Date().toISOString(),
      balanceBefore: before,
      balanceAfter: wallet.balances.NAIRA,
    };
    tx.markModified('apiResponse');
    await tx.save();

    if (wallet.balances.NAIRA < 0) {
      notify(tx.user, {
        type: 'info',
        text: `Your account has a pending balance of ₦${Math.abs(wallet.balances.NAIRA).toLocaleString()} to be paid. This amount will be debited when you recharge.`,
        link: '/user/transaction-history',
      }).catch(() => {});
    } else {
      notify(tx.user, {
        type: 'info',
        text: `₦${tx.amount.toLocaleString()} has been deducted from your wallet for a data transaction that was previously refunded in error.`,
        link: '/user/transaction-history',
      }).catch(() => {});
    }

    return res.json({
      success: true,
      message: `Deducted ₦${tx.amount.toLocaleString()}. Balance: ₦${before.toLocaleString()} → ₦${wallet.balances.NAIRA.toLocaleString()}`,
    });
  } catch (err) {
    console.error('[flagged deduct]', err);
    return res.json({ success: false, message: 'Server error' });
  }
}];

// POST /clear
// Dismiss a flagged entry — moves it to the Cleared tab.
exports.clearTransaction = [authenticateAdminUser, async (req, res) => {
  try {
    const { transactionId } = req.body;
    const tx = await Transaction.findById(transactionId);
    if (!tx) return res.json({ success: false, message: 'Transaction not found' });

    tx.adminCleared   = true;
    tx.adminClearedAt = new Date();
    tx.adminClearedBy = req.user?.username || 'admin';
    await tx.save();

    return res.json({ success: true, message: 'Transaction cleared.' });
  } catch (err) {
    console.error('[flagged clear]', err);
    return res.json({ success: false, message: 'Server error' });
  }
}];

// POST /refund-deduction
// Reverse an admin-deducted wallet charge.
// super_admin: immediate refund + user notification.
// junior/senior: creates a pending request that super_admin must approve.
exports.adminRefundDeduction = [authenticateAdminUser, async (req, res) => {
  try {
    const { transactionId, reason } = req.body;
    if (!transactionId || !reason || !reason.trim()) {
      return res.json({ success: false, message: 'Transaction ID and reason are required.' });
    }

    const tx = await Transaction.findById(transactionId).populate('user', 'username email');
    if (!tx) return res.json({ success: false, message: 'Transaction not found.' });
    if (!tx.apiResponse?.adminDeducted) return res.json({ success: false, message: 'This transaction has not been admin-deducted.' });
    if (tx.apiResponse?.adminRefunded)  return res.json({ success: false, message: 'This transaction has already been refunded.' });
    if (tx.apiResponse?.refundPending)  return res.json({ success: false, message: 'A refund request is already pending for this transaction.' });

    const isSuperAdmin = req.user.role === 'super_admin';

    if (isSuperAdmin) {
      const wallet = await Wallet.findOne({ user: tx.user._id || tx.user });
      if (!wallet) return res.json({ success: false, message: 'User wallet not found.' });

      const before = wallet.balances.NAIRA;
      wallet.balances.NAIRA += tx.amount;
      await wallet.save();

      tx.balanceBefore = before;
      tx.balanceAfter  = wallet.balances.NAIRA;
      tx.apiResponse = {
        ...tx.apiResponse,
        adminRefunded:    true,
        adminRefundedAt:  new Date().toISOString(),
        refundReason:     reason.trim(),
        refundApprovedBy: req.user.username,
        refundPending:    false,
        refundBalBefore:  before,
        refundBalAfter:   wallet.balances.NAIRA,
      };
      tx.markModified('apiResponse');
      await tx.save();

      notify(tx.user._id || tx.user, {
        type: 'info',
        text: `Your wallet has been credited with ₦${tx.amount.toLocaleString()}. Reason: ${reason.trim()}`,
        link: '/user/transaction-history',
      }).catch(() => {});

      return res.json({ success: true, immediate: true, message: `₦${tx.amount.toLocaleString()} refunded to ${tx.user?.username || 'user'}'s wallet.` });
    } else {
      tx.apiResponse = {
        ...tx.apiResponse,
        refundPending:      true,
        refundPendingAt:    new Date().toISOString(),
        refundReason:       reason.trim(),
        refundRequestedBy:  req.user.username,
      };
      tx.markModified('apiResponse');
      await tx.save();

      return res.json({ success: true, immediate: false, message: 'Refund request submitted for approval.' });
    }
  } catch (err) {
    console.error('[adminRefundDeduction]', err);
    return res.json({ success: false, message: 'Server error.' });
  }
}];

// POST /approve-refund
// super_admin approves a pending refund request.
exports.approveRefundRequest = [authenticateAdminUser, async (req, res) => {
  try {
    if (req.user.role !== 'super_admin') {
      return res.status(403).json({ success: false, message: 'Only super admins can approve refund requests.' });
    }

    const { transactionId } = req.body;
    if (!transactionId) return res.json({ success: false, message: 'Transaction ID is required.' });

    const tx = await Transaction.findById(transactionId).populate('user', 'username email');
    if (!tx) return res.json({ success: false, message: 'Transaction not found.' });
    if (!tx.apiResponse?.refundPending) return res.json({ success: false, message: 'No pending refund request for this transaction.' });
    if (tx.apiResponse?.adminRefunded)  return res.json({ success: false, message: 'This transaction has already been refunded.' });

    const wallet = await Wallet.findOne({ user: tx.user._id || tx.user });
    if (!wallet) return res.json({ success: false, message: 'User wallet not found.' });

    const before = wallet.balances.NAIRA;
    wallet.balances.NAIRA += tx.amount;
    await wallet.save();

    const reason = tx.apiResponse.refundReason;

    tx.balanceBefore = before;
    tx.balanceAfter  = wallet.balances.NAIRA;
    tx.apiResponse = {
      ...tx.apiResponse,
      adminRefunded:    true,
      adminRefundedAt:  new Date().toISOString(),
      refundApprovedBy: req.user.username,
      refundPending:    false,
      refundBalBefore:  before,
      refundBalAfter:   wallet.balances.NAIRA,
    };
    tx.markModified('apiResponse');
    await tx.save();

    notify(tx.user._id || tx.user, {
      type: 'info',
      text: `Your wallet has been credited with ₦${tx.amount.toLocaleString()}. Reason: ${reason || 'Admin refund approved'}`,
      link: '/user/transaction-history',
    }).catch(() => {});

    return res.json({ success: true, message: `Refund of ₦${tx.amount.toLocaleString()} approved and credited to ${tx.user?.username || 'user'}'s wallet.` });
  } catch (err) {
    console.error('[approveRefundRequest]', err);
    return res.json({ success: false, message: 'Server error.' });
  }
}];

// POST /resolve
// Case 2 (new): status=pending, wallet is already deducted.
//   action=delivered → mark success (data arrived, charge is correct — no wallet change)
//   action=refund    → credit wallet back and mark refunded (data never arrived)
exports.resolveTransaction = [authenticateAdminUser, async (req, res) => {
  try {
    const { transactionId, action } = req.body;
    if (!['delivered', 'refund'].includes(action)) {
      return res.json({ success: false, message: 'Invalid action' });
    }

    const tx = await Transaction.findById(transactionId);
    if (!tx) return res.json({ success: false, message: 'Transaction not found' });
    if (tx.status !== 'pending') return res.json({ success: false, message: 'Transaction is no longer pending' });
    if (!tx.apiResponse?._timedOut) return res.json({ success: false, message: 'Not a timeout transaction' });

    if (action === 'delivered') {
      tx.status = 'success';
      tx.apiResponse = { status: 'success', _resolvedByAdmin: true, resolvedAt: new Date().toISOString() };
      tx.markModified('apiResponse');
      await tx.save();
      return res.json({ success: true, message: 'Transaction marked as delivered. Wallet charge stands.' });
    }

    // action === 'refund'
    const wallet = await Wallet.findOne({ user: tx.user });
    if (!wallet) return res.json({ success: false, message: 'User wallet not found' });

    const before = wallet.balances.NAIRA;
    wallet.balances.NAIRA += tx.amount;
    await wallet.save();

    tx.status       = 'refunded';
    tx.balanceBefore = before;
    tx.balanceAfter  = wallet.balances.NAIRA;
    tx.apiResponse = {
      status: 'fail',
      _resolvedByAdmin: true,
      adminRefunded: true,
      resolvedAt: new Date().toISOString(),
      balanceBefore: before,
      balanceAfter: wallet.balances.NAIRA,
    };
    tx.markModified('apiResponse');
    await tx.save();

    return res.json({
      success: true,
      message: `Refunded ₦${tx.amount.toLocaleString()} to user. Balance: ₦${before.toLocaleString()} → ₦${wallet.balances.NAIRA.toLocaleString()}`,
    });
  } catch (err) {
    console.error('[flagged resolve]', err);
    return res.json({ success: false, message: 'Server error' });
  }
}];
