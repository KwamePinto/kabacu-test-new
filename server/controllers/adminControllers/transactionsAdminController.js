const { authenticateAdminUser } = require('../../config/authMiddleware');
const Transaction = require('../../models/TransactionModel');
const Wallet      = require('../../models/WalletModal');
const { notify }  = require('../../services/userNotificationService');

// ── Helpers ────────────────────────────────────────────────────────────────────

// A transaction is "attention" if OurDataStore never responded (timeout / network drop).
function isAttention(tx) {
  return tx.status === 'pending' && tx.apiResponse && tx.apiResponse._timedOut;
}

// Suspicious rules — returns array of reason strings.
function suspiciousReasons(tx, allTxForUser) {
  const reasons = [];

  // 1. Wallet went negative
  if (tx.balanceAfter != null && tx.balanceAfter < 0) {
    reasons.push('Balance went negative after transaction');
  }

  // 2. Multiple attention/pending transactions for same user in last 24h
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recentAttention = allTxForUser.filter(t =>
    t._id.toString() !== tx._id.toString() &&
    isAttention(t) &&
    new Date(t.createdAt) > oneDayAgo
  ).length;
  if (recentAttention >= 2) {
    reasons.push(`${recentAttention + 1} unresolved attention transactions in 24h`);
  }

  // 3. Duplicate purchase — same user + phone + amount within 2h
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const duplicate = allTxForUser.find(t =>
    t._id.toString() !== tx._id.toString() &&
    t.phone === tx.phone &&
    t.amount === tx.amount &&
    new Date(t.createdAt) > twoHoursAgo
  );
  if (duplicate) {
    reasons.push('Duplicate order (same phone + amount within 2h)');
  }

  // 4. Multiple failures before a success within 1h
  if (tx.status === 'success') {
    const oneHourAgo = new Date(tx.createdAt.getTime() - 60 * 60 * 1000);
    const priorFails = allTxForUser.filter(t =>
      t._id.toString() !== tx._id.toString() &&
      t.phone === tx.phone &&
      t.amount === tx.amount &&
      t.status === 'failed' &&
      new Date(t.createdAt) > oneHourAgo &&
      new Date(t.createdAt) < tx.createdAt
    ).length;
    if (priorFails >= 2) {
      reasons.push(`${priorFails} failed attempts before this success`);
    }
  }

  return reasons;
}

// ── View all transactions ──────────────────────────────────────────────────────
exports.viewTransactions = [authenticateAdminUser, async (req, res) => {
  try {
    const transactions = await Transaction.find()
      .populate('user', 'username email firstname')
      .populate('product', 'item_name category dataDetails costPrice')
      .populate('products.product', 'item_name category')
      .sort({ createdAt: -1 })
      .limit(1000)
      .lean();

    // Group by user for suspicious-rule checks
    const byUser = {};
    transactions.forEach(tx => {
      const uid = tx.user?._id?.toString() || 'unknown';
      if (!byUser[uid]) byUser[uid] = [];
      byUser[uid].push(tx);
    });

    const enriched = transactions.map(tx => {
      const uid = tx.user?._id?.toString() || 'unknown';
      return {
        ...tx,
        _isAttention: isAttention(tx),
        _suspicious:  suspiciousReasons(tx, byUser[uid] || []),
      };
    });

    res.render('adminview/tables/transactions', {
      layout: 'layouts/adminLayout',
      transactions: enriched,
    });
  } catch (err) {
    console.error('[viewTransactions]', err);
    res.render('adminview/tables/transactions', {
      layout: 'layouts/adminLayout',
      transactions: [],
      error: 'Failed to load transactions',
    });
  }
}];

// ── Resolve attention transaction (toggle to success or refund) ────────────────
exports.resolveAttention = [authenticateAdminUser, async (req, res) => {
  try {
    const { transactionId, action } = req.body;
    if (!['success', 'refund'].includes(action)) {
      return res.json({ success: false, message: 'Invalid action' });
    }

    const tx = await Transaction.findById(transactionId);
    if (!tx)                    return res.json({ success: false, message: 'Transaction not found' });
    if (!isAttention(tx))       return res.json({ success: false, message: 'Not an attention transaction' });

    if (action === 'success') {
      tx.status = 'success';
      tx.apiResponse = { ...tx.apiResponse, _resolvedByAdmin: true, adminAction: 'marked-success', resolvedAt: new Date().toISOString() };
      tx.markModified('apiResponse');
      await tx.save();

      notify(tx.user, {
        type: 'success',
        text: `Your data order of ₦${(tx.amount || 0).toLocaleString()} has been confirmed as delivered.`,
        link: '/user/transaction-history',
      });

      return res.json({ success: true, message: 'Transaction marked as successful.' });
    }

    // action === 'refund'
    const wallet = await Wallet.findOne({ user: tx.user });
    if (!wallet) return res.json({ success: false, message: 'User wallet not found' });

    const before = wallet.balances.NAIRA;
    wallet.balances.NAIRA += tx.amount;
    await wallet.save();

    tx.status = 'refunded';
    tx.apiResponse = { ...tx.apiResponse, _resolvedByAdmin: true, adminAction: 'refunded', resolvedAt: new Date().toISOString(), balanceBefore: before, balanceAfterRefund: wallet.balances.NAIRA };
    tx.markModified('apiResponse');
    tx.refundedAt = new Date();
    await tx.save();

    notify(tx.user, {
      type: 'refund',
      text: `Your data order of ₦${(tx.amount || 0).toLocaleString()} was not delivered. ₦${(tx.amount || 0).toLocaleString()} has been refunded to your wallet.`,
      link: '/user/transaction-history',
    });

    return res.json({ success: true, message: `Refunded ₦${tx.amount.toLocaleString()} to user.` });
  } catch (err) {
    console.error('[resolveAttention]', err);
    return res.json({ success: false, message: 'Server error' });
  }
}];

// ── Force-refund a successful transaction ─────────────────────────────────────
exports.forceRefund = [authenticateAdminUser, async (req, res) => {
  try {
    const { transactionId } = req.body;

    const tx = await Transaction.findById(transactionId);
    if (!tx)                        return res.json({ success: false, message: 'Transaction not found' });
    if (tx.status !== 'success')    return res.json({ success: false, message: 'Only successful transactions can be force-refunded' });
    if (tx.paymentMethod !== 'wallet') return res.json({ success: false, message: 'Can only refund wallet transactions' });

    const wallet = await Wallet.findOne({ user: tx.user });
    if (!wallet) return res.json({ success: false, message: 'User wallet not found' });

    const before = wallet.balances.NAIRA;
    wallet.balances.NAIRA += tx.amount;
    await wallet.save();

    tx.status = 'refunded';
    tx.apiResponse = { ...(tx.apiResponse || {}), adminForceRefund: true, refundedBy: 'admin', refundedAt: new Date().toISOString(), balanceBefore: before, balanceAfterRefund: wallet.balances.NAIRA };
    tx.markModified('apiResponse');
    tx.refundedAt = new Date();
    await tx.save();

    notify(tx.user, {
      type: 'refund',
      text: `A refund of ₦${(tx.amount || 0).toLocaleString()} has been issued to your wallet by admin.`,
      link: '/user/transaction-history',
    });

    return res.json({ success: true, message: `Force-refunded ₦${tx.amount.toLocaleString()} to user.` });
  } catch (err) {
    console.error('[forceRefund]', err);
    return res.json({ success: false, message: 'Server error' });
  }
}];

// ── Clear / dismiss a transaction from the flagged view ───────────────────────
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
    console.error('[clearTransaction]', err);
    return res.json({ success: false, message: 'Server error' });
  }
}];
