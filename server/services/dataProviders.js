const { networkCode, buyData: odsBuyData } = require('./ourdatastore');
const gsubz  = require('./gsubz');
const logger = require('../config/logger');

// Same 60s ceiling every existing ODS call site races against — kept here so
// both provider branches share one number instead of two call sites drifting
// out of sync with each other.
const TIMEOUT_MS = 60000;

/**
 * Buys a data bundle for `product` (a DATA-category Product doc) and
 * `phone`, routed to whichever provider `product.dataDetails.provider` names.
 * Always resolves — never throws — with the same shape either branch takes:
 *
 *   { status: 'success' | 'fail' | 'pending', ... }
 *
 * This is the exact shape ODS's 5 live purchase call sites already branch on
 * (each built its own copy of this race+catch+classify block inline before
 * this dispatcher existed) — so a call site's `buyData({...})` call becomes
 * one line, `purchaseData(product, phone)`, with everything after it
 * (`apiResponse.status === 'success'`, etc.) unchanged.
 */
async function purchaseData(product, phone) {
  const details = product && product.dataDetails ? product.dataDetails : {};
  if (details.provider === 'GSUBZ') return purchaseGsubz(details, phone, product && product.costPrice);
  return purchaseOds(details, phone);
}

async function purchaseOds(details, phone) {
  try {
    return await Promise.race([
      odsBuyData({
        network: await networkCode(details.network),
        phone,
        data_plan: details.plan_id,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Request timeout')), TIMEOUT_MS)),
    ]);
  } catch (err) {
    if (err.response) {
      return { status: 'fail', message: err.response?.data?.message || 'API error' };
    }
    const reason = err.message === 'Request timeout' ? 'timeout' : (err.code || err.message);
    return { status: 'pending', _timedOut: true, _reason: reason };
  }
}

// GSubz's /pay response shape is NOT the single documented envelope
// (gsubz_doc.md §3.6's `content: {code:"000", status:"TRANSACTION_SUCCESSFUL"}`
// wrapper) -- a live test purchase against the real endpoint (mtn_sme,
// 2026-09-04) returned a THIRD, undocumented, flat shape instead:
//   {code: 200 (number), status: "successful" (lowercase, no content wrapper),
//    transactionID, amountPaid, initialBalance, finalBalance, api_response}
// Trusting only the documented shape misclassified that real, confirmed
// delivery (api_response literally said "You have gifted 500MB...") as a
// failure and triggered a wallet refund while GSubz had already been charged
// and the customer had already received the data -- the exact double-loss
// scenario the whole pending/refund pipeline in this codebase exists to
// prevent. Every shape actually observed live is checked here; do not narrow
// this back to a single shape without re-testing against a real purchase.
function isGsubzSuccess(raw) {
  if (!raw) return false;
  const content = raw.content;
  if (content && (content.code === '000' || String(content.status || '').toUpperCase() === 'TRANSACTION_SUCCESSFUL')) {
    return true;
  }
  const topStatus = String(raw.status || '').toUpperCase();
  return topStatus === 'SUCCESSFUL' || topStatus === 'TRANSACTION_SUCCESSFUL';
}

async function resolveGsubzPlan(planName) {
  if (!planName) return null;
  const GsubzPlan = require('../models/GsubzPlanModel');
  return GsubzPlan.findOne({ name: planName, is_deleted: { $ne: 1 } }).lean();
}

async function purchaseGsubz(details, phone, costPrice) {
  const plan = await resolveGsubzPlan(details.network);
  if (!plan) {
    logger.error(`[GSUBZ PURCHASE] No configured plan matches "${details.network}"`);
    return { status: 'fail', message: 'GSubz plan not configured' };
  }

  // GSubz's /pay `amount` must be its OWN price for this plan (gsubz_doc.md
  // §3.6: "must match the plan's price"), not the marked-up customer price
  // in dataDetails.amount -- those two only coincide by chance. This is
  // exactly what Product.costPrice already exists for ("internal profit
  // tracking only"), the same way ODS's `data_plan` id implies its own price
  // server-side without us ever having to state it. Falls back to
  // dataDetails.amount only if costPrice was left at 0/unset, so a
  // misconfigured product fails loudly at GSubz rather than silently
  // charging phantom kobo — but a correctly-configured GSubz product should
  // always have a real costPrice set.
  const payAmount = costPrice > 0 ? costPrice : details.amount;

  // Generated here, before the network call, so a lost/timed-out response is
  // still reconciliable by this ID afterward (same reasoning gsubz_doc.md and
  // ourdatastore.js's executeBuyData both document for their own requestIDs).
  const requestID = `GSUBZ_${Date.now()}`;

  try {
    const raw = await Promise.race([
      gsubz.buyData({
        serviceID: plan.serviceID,
        plan: details.gsubz_plan_code,
        phone,
        amount: payAmount,
        requestID,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Request timeout')), TIMEOUT_MS)),
    ]);

    const success = isGsubzSuccess(raw);
    return { status: success ? 'success' : 'fail', requestId: requestID, raw };
  } catch (err) {
    if (err.response) {
      return {
        status: 'fail',
        message: err.response?.data?.description || 'API error',
        requestId: requestID,
      };
    }
    const reason = err.message === 'Request timeout' ? 'timeout' : (err.code || err.message);
    return { status: 'pending', _timedOut: true, _reason: reason, requestId: requestID };
  }
}

module.exports = { purchaseData };
