const Transaction = require('../models/TransactionModel');
const Wallet      = require('../models/WalletModal');
const User        = require('../models/UserModel');
const { getTransactionStatus, lookupByPhoneAndTime } = require('./ourdatastore');
const logger = require('../config/logger');

const POLL_INTERVAL_MS      = 2  * 60 * 1000;  // check every 2 minutes
const AUTO_REFUND_AFTER_MS  = 30 * 60 * 1000;  // start ODS check at 30 minutes
const HARD_REFUND_AFTER_MS  = 2  * 60 * 60 * 1000; // hard auto-refund if ODS still unclear after 2 hours

async function pollPendingTransactions() {
  const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
  const pending = await Transaction.find({
    status: 'pending',
    createdAt: { $lt: twoMinutesAgo },
  });

  if (!pending.length) return;
  logger.info(`[POLLER] Checking ${pending.length} pending transaction(s)`);

  for (const tx of pending) {
    try {
      const age       = Date.now() - new Date(tx.createdAt).getTime();
      const requestId = tx.apiResponse?.requestId;

      if (age > AUTO_REFUND_AFTER_MS) {
        // Before refunding, ask OurDataStore whether data was actually delivered.
        // This prevents refunding users who received data despite our server timing out.
        let odsResult = null;
        try {
          odsResult = await lookupByPhoneAndTime(tx.phone, tx.createdAt);
        } catch (odsErr) {
          logger.error(`[POLLER] TX ${tx._id}: OurDataStore lookup error: ${odsErr.message}`);
          // A thrown lookup is also "could not ask", never "not delivered".
          odsResult = { found: false, unreachable: true, error: odsErr.message };
        }

        if (odsResult?.found && odsResult.planStatus === 1) {
          // OurDataStore confirms data was delivered — do NOT refund, mark success.
          tx.status = 'success';
          tx.apiResponse = {
            ...(tx.apiResponse || {}),
            _pollerResolved: true,
            _odsConfirmed: 'delivered',
            _odsTransid:   odsResult.transid,
            _odsDate:      odsResult.odsDate,
          };
          tx.markModified('apiResponse');
          await tx.save();
          if (tx.rpEarned > 0) {
            await User.findByIdAndUpdate(tx.user, { $inc: { rpBalance: tx.rpEarned } });
          }
          logger.info(`[POLLER] TX ${tx._id} → SUCCESS (OurDataStore confirmed delivery, transid: ${odsResult.transid})`);

        } else if (odsResult?.found && odsResult.planStatus === 2) {
          // OurDataStore confirms failure — refund is correct.
          await refundAndFail(tx, 'OurDataStore confirmed failure');

        } else if (age > HARD_REFUND_AFTER_MS && !odsResult?.unreachable) {
          // Still uncertain after 2 hours, and we DID manage to ask — the
          // window was searched and no delivery was found. Refunding is
          // justified. Flagged for admin review either way.
          await refundAndFail(tx, 'auto-refund after 2h: OurDataStore searched, no delivery found');

        } else if (age > HARD_REFUND_AFTER_MS && odsResult?.unreachable) {
          // We could NOT ask. Refunding here is exactly how a delivered order
          // gets its money returned too: an outage on their side would look
          // identical to a failed delivery. Hold the transaction pending and
          // surface it for a human instead of guessing.
          tx.apiResponse = {
            ...(tx.apiResponse || {}),
            _odsUnreachable: true,
            _odsUnreachableAt: new Date().toISOString(),
            _odsUnreachableError: odsResult.error || '',
            _needsManualReview: true,
          };
          tx.markModified('apiResponse');
          await tx.save();
          logger.warn(`[POLLER] TX ${tx._id}: past 2h but OurDataStore is UNREACHABLE (${odsResult.error}) — holding pending for manual review rather than refunding`);

        } else {
          // OurDataStore is uncertain or still processing — check again next poll cycle.
          logger.info(`[POLLER] TX ${tx._id}: OurDataStore status uncertain (age ${Math.round(age / 60000)}min), will retry`);
        }
        continue;
      }

      if (!requestId) {
        logger.warn(`[POLLER] TX ${tx._id}: no requestId in apiResponse, skipping`);
        continue;
      }

      const planStatus = await getTransactionStatus(requestId);
      logger.info(`[POLLER] TX ${tx._id} (${requestId}) plan_status=${planStatus}`);

      if (planStatus === 1) {
        tx.status = 'success';
        await tx.save();
        if (tx.rpEarned > 0) {
          await User.findByIdAndUpdate(tx.user, { $inc: { rpBalance: tx.rpEarned } });
        }
        logger.info(`[POLLER] TX ${tx._id} → SUCCESS`);
      } else if (planStatus === 2) {
        await refundAndFail(tx, 'provider confirmed failure');
      }
      // plan_status 3 (still processing) or null (not found yet): leave pending
    } catch (err) {
      logger.error(`[POLLER] Error on TX ${tx._id}: ${err.message}`);
    }
  }
}

async function refundAndFail(tx, reason) {
  if (tx.walletCredited) {
    logger.warn(`[POLLER] TX ${tx._id}: wallet already credited (idempotency guard), skipping refund`);
    tx.status = 'failed';
    await tx.save();
    return;
  }

  if (tx.walletType === 'NAIRA') {
    const wallet = await Wallet.findOne({ user: tx.user });
    if (wallet) {
      const before = wallet.balances.NAIRA;
      wallet.balances.NAIRA += tx.amount;
      await wallet.save();

      tx.walletCredited = true;
      // The refund restores the balance, so the row's net effect is zero.
      // Recording after == before keeps the statement chain continuous —
      // leaving the original debit here is what made 266 historic rows
      // discontinuous.
      tx.balanceAfter  = wallet.balances.NAIRA;
      if (tx.balanceBefore == null) tx.balanceBefore = wallet.balances.NAIRA;
      tx.balanceSource = 'live';
      tx.apiResponse = {
        ...(tx.apiResponse || {}),
        _pollerRefunded: true,
        _pollerRefundedAt: new Date().toISOString(),
        _pollerReason: reason,
        _refundBalBefore: before,
        _refundBalAfter: wallet.balances.NAIRA,
      };
      tx.markModified('apiResponse');
    }
  }

  tx.status = 'failed';
  await tx.save();
  logger.info(`[POLLER] TX ${tx._id} → FAILED & refunded (${reason})`);
}

function startPoller() {
  setInterval(async () => {
    try { await pollPendingTransactions(); }
    catch (err) { logger.error(`[POLLER] Unhandled error: ${err.message}`); }
  }, POLL_INTERVAL_MS);
  logger.info('[POLLER] Transaction poller started — interval: 2 min, auto-refund after: 30 min');
}

module.exports = { startPoller, pollPendingTransactions };
