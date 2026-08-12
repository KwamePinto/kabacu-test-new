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

// ── View all transactions (page shell — data loaded via AJAX) ─────────────────
exports.viewTransactions = [authenticateAdminUser, (req, res) => {
  res.render('adminview/tables/transactions', {
    layout: 'layouts/adminLayout',
  });
}];

// ── DataTables server-side data endpoint ──────────────────────────────────────
exports.getTransactionsData = [authenticateAdminUser, async (req, res) => {
  try {
    const draw   = parseInt(req.query.draw)   || 1;
    const start  = parseInt(req.query.start)  || 0;
    const length = Math.min(parseInt(req.query.length) || 50, 500);
    const search = (req.query['search[value]'] ?? req.query.search?.value)?.trim() || '';

    // Sortable column map (index matches thead order)
    const SORT_COLS = {
      1: 'reference',
      3: 'phone',
      5: 'amount',
      6: 'walletType',
      7: 'rpEarned',
      8: 'status',
      9: 'createdAt',
    };
    const orderColIdx = parseInt(req.query['order[0][column]'] ?? req.query.order?.[0]?.column) || 9;
    const orderDir    = (req.query['order[0][dir]'] ?? req.query.order?.[0]?.dir) === 'asc' ? 1 : -1;
    const sortField   = SORT_COLS[orderColIdx] || 'createdAt';

    // Build filter — search across reference, phone, status, and user name/email
    let filter = {};
    if (search) {
      // Escape regex special characters so e.g. "+" in phone numbers doesn't throw
      const safeSearch = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const User = require('../../models/UserModel');
      const matchingUsers = await User.find({
        $or: [
          { username:  { $regex: safeSearch, $options: 'i' } },
          { email:     { $regex: safeSearch, $options: 'i' } },
          { firstname: { $regex: safeSearch, $options: 'i' } },
        ],
      }).select('_id').lean();

      const userIds = matchingUsers.map(u => u._id);
      filter = {
        $or: [
          { reference: { $regex: safeSearch, $options: 'i' } },
          { phone:     { $regex: safeSearch, $options: 'i' } },
          { status:    { $regex: safeSearch, $options: 'i' } },
          ...(userIds.length ? [{ user: { $in: userIds } }] : []),
        ],
      };
    }

    const [totalCount, filteredCount, rows] = await Promise.all([
      Transaction.countDocuments(),
      Transaction.countDocuments(filter),
      Transaction.find(filter)
        .populate('user', 'username email firstname')
        .populate('product', 'item_name dataDetails')
        .sort({ [sortField]: orderDir })
        .skip(start)
        .limit(length)
        .lean(),
    ]);

    const data = rows.map((tx, i) => ({
      rowNum:    start + i + 1,
      reference: tx.reference || '—',
      user:      tx.user ? { id: tx.user._id, name: tx.user.firstname || tx.user.username || tx.user.email } : null,
      phone:     tx.phone || 'N/A',
      product:   tx.product?.item_name || tx.product?.dataDetails?.plan_name || 'N/A',
      amount:    tx.amount,
      walletType: tx.walletType || '—',
      rpEarned:  tx.rpEarned || 0,
      status:    tx.status,
      createdAt: new Date(tx.createdAt).toLocaleString('en-GB', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
      }),
    }));

    res.json({ draw, recordsTotal: totalCount, recordsFiltered: filteredCount, data });
  } catch (err) {
    console.error('[getTransactionsData]', err);
    res.json({ draw: 1, recordsTotal: 0, recordsFiltered: 0, data: [] });
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

    // Create a separate ledger entry so the refund appears as its own statement row
    await Transaction.create({
      user:          tx.user,
      amount:        tx.amount,
      walletType:    tx.walletType || 'NAIRA',
      paymentMethod: 'Admin',
      status:        'success',
      reference:     'ADMIN-REFUND-' + Date.now(),
      balanceBefore: before,
      balanceAfter:  wallet.balances.NAIRA,
      apiResponse: {
        adminRefund:     true,
        adminRefundOf:   tx._id.toString(),
        originalRef:     tx.reference,
        refundReason:    'Order not delivered — refunded by admin',
        refundBy:        req.user?.username || 'admin',
        adminRefundedAt: new Date().toISOString(),
        balanceBefore:   before,
        balanceAfter:    wallet.balances.NAIRA,
      },
    });

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

    // Create a separate ledger entry so the refund appears as its own statement row
    await Transaction.create({
      user:          tx.user,
      amount:        tx.amount,
      walletType:    tx.walletType || 'NAIRA',
      paymentMethod: 'Admin',
      status:        'success',
      reference:     'ADMIN-REFUND-' + Date.now(),
      balanceBefore: before,
      balanceAfter:  wallet.balances.NAIRA,
      apiResponse: {
        adminRefund:     true,
        adminRefundOf:   tx._id.toString(),
        originalRef:     tx.reference,
        refundReason:    'Force-refunded by admin',
        refundBy:        req.user?.username || 'admin',
        adminRefundedAt: new Date().toISOString(),
        balanceBefore:   before,
        balanceAfter:    wallet.balances.NAIRA,
      },
    });

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
