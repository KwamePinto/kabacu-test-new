const Transaction = require('../models/TransactionModel');
const Wallet      = require('../models/WalletModal');
const User        = require('../models/UserModel');
const { getTransactionStatus, lookupByPhoneAndTime } = require('./ourdatastore');
const logger = require('../config/logger');
const { notify } = require('./userNotificationService');

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
      const age = Date.now() - new Date(tx.createdAt).getTime();

      // GSubz transactions never go through OurDataStore's lookup-then-refund
      // path below — that path searches ODS's OWN transaction history, which
      // for a GSubz order finds nothing regardless of what actually happened,
      // and would eventually auto-refund a purchase that may well have been
      // delivered. GSubz's own reconciliation (`gsubz.verify`) has never been
      // confirmed live (gsubz_doc.md §6.2), so it isn't trusted for an
      // automatic decision yet — a GSubz transaction just gets flagged for a
      // human to check with the manual "Check GSubz status" admin action.
      if (tx.provider === 'GSUBZ') {
        await handleGsubzPending(tx, age);
        continue;
      }

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

// GSubz-pending handling — deliberately does far less than the ODS branch
// above. Below 30 minutes it just waits, same as ODS. Past 30 minutes it
// flags the transaction for a human instead of asking a provider-specific
// "was this delivered?" question automatically, because that question has
// no confirmed-safe answer for GSubz yet (see the note at the call site).
// Never auto-refunds. Idempotent — re-flags without re-logging on repeat cycles.
async function handleGsubzPending(tx, age) {
  if (age <= AUTO_REFUND_AFTER_MS) return;
  if (tx.apiResponse?._needsManualReview) return;

  tx.apiResponse = {
    ...(tx.apiResponse || {}),
    _needsManualReview: true,
    _needsManualReviewAt: new Date().toISOString(),
    _needsManualReviewReason: 'gsubz_pending_unreconciled',
  };
  tx.markModified('apiResponse');
  await tx.save();
  logger.warn(`[POLLER] TX ${tx._id}: GSubz pending past ${Math.round(AUTO_REFUND_AFTER_MS / 60000)}min — flagged for manual review, NOT auto-refunded (GSubz reconciliation is not wired into the automatic poller yet)`);
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


// ── Short-delivery sweep ─────────────────────────────────────────────────────
// Large bundles are split by the provider into 5GB legs. When a leg fails they
// still report overall success and the message we store still claims the full
// amount was shared, so a short delivery is invisible on our side. The only
// signal is the leg summary on their record.
//
// OurDataStore-specific: the leg-splitting behavior this sweep looks for (and
// `shortDeliveryAudit`'s history search underneath it) has no confirmed GSubz
// analogue, so GSubz-provider products are excluded from the candidate query
// below rather than searched against the wrong provider's history.
//
// This runs on its own slower interval and STAMPS the transaction, so the
// flagged-transactions page stays an ordinary Mongo query like its other tabs
// instead of making provider calls during a page render.
const SHORT_DELIVERY_INTERVAL_MS = 10 * 60 * 1000; // every 10 minutes
const SHORT_DELIVERY_LOOKBACK_MS = 48 * 60 * 60 * 1000; // only recent orders
const SHORT_DELIVERY_BATCH       = 25; // provider calls per cycle

async function pollShortDelivery() {
  const { checkOne } = require('./shortDeliveryAudit');
  const Product = require('../models/ProductsModal');

  // Only bundles big enough to be split are worth checking. ODS only — see
  // the note above.
  const products = await Product.find({
    category: 'DATA',
    'dataDetails.provider': { $ne: 'GSUBZ' },
  }).select('dataDetails').lean();
  const bigIds = products
    .filter(p => {
      const m = String(p.dataDetails && p.dataDetails.plan_type || '').match(/([\d.]+)\s*GB/i);
      return m && parseFloat(m[1]) > 5;
    })
    .map(p => p._id);

  if (!bigIds.length) return;

  const candidates = await Transaction.find({
    status: 'success',
    product: { $in: bigIds },
    createdAt: { $gte: new Date(Date.now() - SHORT_DELIVERY_LOOKBACK_MS) },
    'apiResponse._shortChecked': { $ne: true },
  }).limit(SHORT_DELIVERY_BATCH);

  if (!candidates.length) return;
  logger.info(`[SHORT-DELIVERY] Checking ${candidates.length} large-bundle purchase(s)`);

  const productById = new Map(products.map(p => [String(p._id), p]));

  for (const tx of candidates) {
    try {
      const result = await checkOne(tx, { productById });

      // null means we could not determine it — provider unreachable or no
      // record yet. Leave it unstamped so the next cycle retries, rather than
      // recording an absence of evidence as evidence of delivery.
      if (!result) continue;

      tx.apiResponse = {
        ...(tx.apiResponse || {}),
        _shortChecked: true,
        _shortCheckedAt: new Date().toISOString(),
      };

      if (result.short) {
        Object.assign(tx.apiResponse, {
          _shortDelivered: true,
          _shortBoughtGb:  result.boughtGb,
          _shortDeliveredGb: result.deliveredGb,
          _shortMissingGb: result.missingGb,
          _shortLegs:      result.legs,
          _shortLegsOk:    result.legsOk,
          _shortLostValue: result.lostValue,
          _shortOdsMessage: result.odsMessage,
          // Needed to find the matching top-up bundle on the same plan family
          _shortNetwork:   result.network,
          _shortPlanType:  result.planType,
        });
        logger.warn(`[SHORT-DELIVERY] TX ${tx._id} (${tx.reference}): bought ${result.boughtGb}GB, delivered ${result.deliveredGb}GB (${result.legsOk}/${result.legs} legs) — value not delivered ₦${result.lostValue}`);

        notify(tx.user, {
          type: 'attention',
          text: `We found that only ${result.deliveredGb}GB of your ${result.boughtGb}GB purchase was delivered. Our team is resolving it.`,
          link: '/user/transaction-history',
        });
      }

      tx.markModified('apiResponse');
      await tx.save();
    } catch (err) {
      logger.error(`[SHORT-DELIVERY] Error on TX ${tx._id}: ${err.message}`);
    }
  }
}

function startPoller() {
  setInterval(async () => {
    try { await pollPendingTransactions(); }
    catch (err) { logger.error(`[POLLER] Unhandled error: ${err.message}`); }
  }, POLL_INTERVAL_MS);

  // Separate, slower interval: detects partial deliveries on large bundles and
  // stamps them so the flagged page can query them like any other tab.
  setInterval(async () => {
    try { await pollShortDelivery(); }
    catch (err) { logger.error(`[SHORT-DELIVERY] Unhandled error: ${err.message}`); }
  }, SHORT_DELIVERY_INTERVAL_MS);

  logger.info('[POLLER] Transaction poller started — interval: 2 min, auto-refund after: 30 min');
  logger.info('[SHORT-DELIVERY] Sweep started — interval: 10 min, lookback: 48h');
}

module.exports = { startPoller, pollPendingTransactions, pollShortDelivery };
