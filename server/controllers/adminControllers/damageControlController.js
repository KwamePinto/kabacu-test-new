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

    // Count only — full lists are loaded lazily per tab
    const alreadyDeducted = await Transaction.countDocuments({
      paymentMethod: 'wallet',
      'apiResponse.adminDeducted': true,
      'apiResponse.adminRefunded': { $ne: true },
      'apiResponse.refundPending': { $ne: true },
    });

    res.render('adminview/flagged-transactions', {
      layout: 'layouts/adminLayout',
      rows,
      totalAmount,
      alreadyDeducted,
    });
  } catch (err) {
    console.error('[damageControl]', err);
    res.render('adminview/flagged-transactions', {
      layout: 'layouts/adminLayout',
      rows: [],
      totalAmount: 0,
      alreadyDeducted: 0,
      error: 'Failed to load data',
    });
  }
}];

// GET /tab-data?tab=deducted|cleared|refunded — lazy-loads secondary tab content
exports.getTabData = [authenticateAdminUser, async (req, res) => {
  try {
    const { tab } = req.query;

    if (tab === 'deducted') {
      const rows = await Transaction.find({
        paymentMethod: 'wallet',
        'apiResponse.adminDeducted': true,
        'apiResponse.adminRefunded': { $ne: true },
        'apiResponse.refundPending': { $ne: true },
      }).populate('user', 'username email').sort({ 'apiResponse.adminDeductedAt': -1 }).lean();
      return res.json({ rows });
    }

    if (tab === 'cleared') {
      const rows = await Transaction.find({
        adminCleared: true,
        adminClearedAt: { $gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) },
      }).populate('user', 'username email').sort({ adminClearedAt: -1 }).limit(500).lean();
      return res.json({ rows });
    }

    if (tab === 'refunded') {
      const rows = await Transaction.find({
        paymentMethod: 'wallet',
        'apiResponse.adminDeducted': true,
        $or: [{ 'apiResponse.adminRefunded': true }, { 'apiResponse.refundPending': true }],
      }).populate('user', 'username email').sort({ createdAt: -1 }).lean();
      return res.json({ rows, isSuperAdmin: req.user.role === 'super_admin' });
    }

    return res.status(400).json({ error: 'Invalid tab' });
  } catch (err) {
    console.error('[getTabData]', err);
    res.status(500).json({ error: 'Server error' });
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

      // Create a separate ledger entry so the refund appears as its own statement row
      await Transaction.create({
        user:          tx.user._id || tx.user,
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
          refundReason:    reason.trim(),
          refundBy:        req.user.username,
          adminRefundedAt: new Date().toISOString(),
          balanceBefore:   before,
          balanceAfter:    wallet.balances.NAIRA,
        },
      });

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

    // Create a separate ledger entry so the refund appears as its own statement row
    await Transaction.create({
      user:          tx.user._id || tx.user,
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
        refundReason:    reason || 'Admin refund approved',
        refundBy:        req.user.username,
        adminRefundedAt: new Date().toISOString(),
        balanceBefore:   before,
        balanceAfter:    wallet.balances.NAIRA,
      },
    });

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
        refundReason:    'Flagged transaction resolved — refunded by admin',
        refundBy:        req.user?.username || 'admin',
        adminRefundedAt: new Date().toISOString(),
        balanceBefore:   before,
        balanceAfter:    wallet.balances.NAIRA,
      },
    });

    return res.json({
      success: true,
      message: `Refunded ₦${tx.amount.toLocaleString()} to user. Balance: ₦${before.toLocaleString()} → ₦${wallet.balances.NAIRA.toLocaleString()}`,
    });
  } catch (err) {
    console.error('[flagged resolve]', err);
    return res.json({ success: false, message: 'Server error' });
  }
}];

/**
 * Asks GSubz what actually happened to a stuck-pending transaction, by its
 * requestID — the manual "ask before refunding" tool for GSubz, standing in
 * for the automatic OurDataStore reconciliation in transactionPoller.js,
 * which GSubz transactions deliberately skip (see the note in that file).
 *
 * Read-only: this does not itself mark the transaction resolved either way —
 * the admin still uses "Mark Delivered" / "Refund User" above, informed by
 * whatever GSubz reports here.
 */
exports.checkGsubzStatus = [authenticateAdminUser, async (req, res) => {
  try {
    const { transactionId } = req.body;
    const tx = await Transaction.findById(transactionId);
    if (!tx) return res.json({ success: false, message: 'Transaction not found' });
    if (tx.provider !== 'GSUBZ') return res.json({ success: false, message: 'Not a GSubz transaction' });

    const requestID = tx.apiResponse?.requestId;
    if (!requestID) return res.json({ success: false, message: 'No requestID recorded on this transaction' });

    const { verify } = require('../../services/gsubz');
    const raw = await verify(requestID);
    return res.json({ success: true, raw });
  } catch (err) {
    console.error('[checkGsubzStatus]', err);
    return res.json({ success: false, message: err.response?.data?.description || 'GSubz did not respond' });
  }
}];

// =============================================================================
// SHORT DELIVERY
// =============================================================================
// The provider splits large bundles into 5GB legs. When a leg fails it still
// reports overall success, and the message we store still claims the full
// amount was shared — so this is invisible from our data alone. The background
// sweep in transactionPoller stamps affected transactions; this tab lists them
// and offers the two ways to make the customer whole.

const SHORT_DELIVERY_FILTER = {
  status: 'success',
  'apiResponse._shortDelivered': true,
  'apiResponse._shortResolved': { $ne: true },
  adminCleared: { $ne: true },
};

exports.shortDeliveryRows = [authenticateAdminUser, async (req, res) => {
  try {
    const { findTopUpProduct } = require('../../services/shortDeliveryAudit');

    const rows = await Transaction.find(SHORT_DELIVERY_FILTER)
      .populate('user', 'username email')
      .sort({ createdAt: -1 })
      .lean();

    // Whether an exact top-up bundle exists decides if "Send data" is offered.
    // It is not always possible: AIRTEL has no 5GB (1.5/2/3/4/10GB), so a
    // short-delivered AIRTEL 10GB can only be refunded.
    const out = [];
    for (const tx of rows) {
      const ar = tx.apiResponse || {};
      const topUp = await findTopUpProduct(ar._shortNetwork || '', ar._shortMissingGb);
      out.push({
        ...tx,
        _topUp: topUp ? {
          id: String(topUp._id),
          planType: topUp.dataDetails.plan_type,
          planId: topUp.dataDetails.plan_id,
          cost: topUp.costPrice,
          price: topUp.dataDetails.amount,
        } : null,
      });
    }

    const totals = {
      rows: out.length,
      missingGb: out.reduce((s, r) => s + ((r.apiResponse || {})._shortMissingGb || 0), 0),
      lostValue: out.reduce((s, r) => s + ((r.apiResponse || {})._shortLostValue || 0), 0),
    };

    res.json({ rows: out, totals });
  } catch (err) {
    console.error('[shortDelivery rows]', err);
    res.json({ rows: [], totals: { rows: 0, missingGb: 0, lostValue: 0 } });
  }
}];

/**
 * Refunds the undelivered portion into the customer's wallet.
 *
 * Pro-rata on what they actually paid, and written as its own ledger row so the
 * statement explains the credit instead of showing an unexplained jump.
 */
exports.shortDeliveryRefund = [authenticateAdminUser, async (req, res) => {
  try {
    const tx = await Transaction.findOne({ _id: req.params.id, ...SHORT_DELIVERY_FILTER });
    if (!tx) return res.json({ success: false, message: 'Not found, or already resolved.' });

    const ar = tx.apiResponse || {};
    const amount = Number(ar._shortLostValue) || 0;
    if (!(amount > 0)) return res.json({ success: false, message: 'No shortfall value recorded on this transaction.' });

    // Atomic credit; new:false gives the true before-balance without a re-read.
    const snap = await Wallet.findOneAndUpdate(
      { user: tx.user },
      { $inc: { 'balances.NAIRA': amount } },
      { upsert: true, new: false, setOnInsert: { user: tx.user } },
    );
    const before = (snap && snap.balances && snap.balances.NAIRA) || 0;

    await Transaction.create({
      user: tx.user,
      amount,
      walletType: 'NAIRA',
      paymentMethod: 'Admin',
      status: 'success',
      reference: 'ADMIN-REFUND-' + Date.now(),
      balanceBefore: before,
      balanceAfter: before + amount,
      apiResponse: {
        adminRefund: true,
        adminRefundOf: String(tx._id),
        originalRef: tx.reference,
        refundReason: `Short delivery: ${ar._shortDeliveredGb}GB of ${ar._shortBoughtGb}GB delivered`,
        refundBy: (req.user && req.user.username) || 'admin',
        adminRefundedAt: new Date().toISOString(),
        balanceBefore: before,
        balanceAfter: before + amount,
      },
    });

    tx.apiResponse = {
      ...ar,
      _shortResolved: true,
      _shortResolvedAt: new Date().toISOString(),
      _shortResolvedBy: (req.user && req.user.username) || 'admin',
      _shortResolution: 'refund',
      _shortRefundAmount: amount,
    };
    tx.markModified('apiResponse');
    await tx.save();

    notify(tx.user, {
      type: 'refund',
      text: `Only ${ar._shortDeliveredGb}GB of your ${ar._shortBoughtGb}GB purchase was delivered. ₦${amount.toLocaleString()} has been refunded to your wallet.`,
      link: '/user/transaction-history',
    });

    res.json({ success: true, message: `₦${amount.toLocaleString()} refunded.` });
  } catch (err) {
    console.error('[shortDelivery refund]', err);
    res.json({ success: false, message: 'Server error. Please try again.' });
  }
}];

/**
 * Sends the missing data instead of refunding, using the same-plan bundle for
 * exactly the shortfall and the same validity.
 *
 * The customer already paid for the full bundle, so nothing is charged — the
 * cost falls on our provider balance. Resolution is only recorded if the
 * provider actually confirms success.
 */
exports.shortDeliveryTopUp = [authenticateAdminUser, async (req, res) => {
  try {
    const { findTopUpProduct } = require('../../services/shortDeliveryAudit');
    const { buyData, networkCode, userMessage } = require('../../services/ourdatastore');

    const tx = await Transaction.findOne({ _id: req.params.id, ...SHORT_DELIVERY_FILTER });
    if (!tx) return res.json({ success: false, message: 'Not found, or already resolved.' });

    const ar = tx.apiResponse || {};
    const missingGb = Number(ar._shortMissingGb) || 0;
    if (!(missingGb > 0)) return res.json({ success: false, message: 'No shortfall recorded on this transaction.' });

    const network = ar._shortNetwork || '';
    const topUp = await findTopUpProduct(network, missingGb);
    if (!topUp) {
      return res.json({
        success: false,
        message: `No ${missingGb}GB bundle exists on "${network}", so the shortfall cannot be topped up exactly. Refund instead.`,
      });
    }

    let apiResponse;
    try {
      apiResponse = await Promise.race([
        buyData({
          network: await networkCode(topUp.dataDetails.network),
          phone: tx.phone,
          data_plan: topUp.dataDetails.plan_id,
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Request timeout')), 60000)),
      ]);
    } catch (err) {
      return res.json({
        success: false,
        message: 'The provider did not confirm the top-up. Nothing was recorded — check the provider dashboard before retrying, so the customer is not sent data twice.',
      });
    }

    if (!apiResponse || apiResponse.status !== 'success') {
      return res.json({ success: false, message: userMessage(apiResponse, 'Top-up failed. Nothing was recorded.') });
    }

    // Auditable record of the goodwill delivery. Zero amount: the customer was
    // already charged for the full bundle on the original transaction.
    await Transaction.create({
      user: tx.user,
      product: topUp._id,
      phone: tx.phone,
      amount: 0,
      rpEarned: 0,
      walletType: 'NAIRA',
      paymentMethod: 'Admin',
      status: 'success',
      reference: 'ADMIN-TOPUP-' + Date.now(),
      apiResponse: {
        ...apiResponse,
        adminShortDeliveryTopUp: true,
        topUpOf: String(tx._id),
        originalRef: tx.reference,
        topUpGb: missingGb,
        providerCost: topUp.costPrice,
        topUpBy: (req.user && req.user.username) || 'admin',
      },
    });

    tx.apiResponse = {
      ...ar,
      _shortResolved: true,
      _shortResolvedAt: new Date().toISOString(),
      _shortResolvedBy: (req.user && req.user.username) || 'admin',
      _shortResolution: 'topup',
      _shortTopUpGb: missingGb,
      _shortTopUpPlanId: topUp.dataDetails.plan_id,
    };
    tx.markModified('apiResponse');
    await tx.save();

    notify(tx.user, {
      type: 'success',
      text: `The missing ${missingGb}GB from your earlier purchase has been sent to ${tx.phone}.`,
      link: '/user/transaction-history',
    });

    res.json({ success: true, message: `${missingGb}GB sent to ${tx.phone}.` });
  } catch (err) {
    console.error('[shortDelivery topup]', err);
    res.json({ success: false, message: 'Server error. Please try again.' });
  }
}];
