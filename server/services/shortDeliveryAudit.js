/**
 * TEMPORARY — short-delivery audit.
 *
 * Detects purchases where OurDataStore reported overall success but only part
 * of the bundle was delivered.
 *
 * Large bundles are split into 5GB legs. When a leg fails, ODS still returns
 * plan_status = 1 and the message we store still claims the full amount was
 * shared — so nothing on our side reveals it. The only signal is the ODS row's
 * `api_response`:
 *
 *     "Hello Chief! 1 Failed 2 Successful and 0 Unsure out of the transactions"
 *
 * ODS `transid` equals our `apiResponse.requestId`, so the two sides join on a
 * key rather than a fuzzy phone + time window.
 *
 * Delivered volume is assumed proportional to successful legs, matching the
 * observed 5GB granularity (15GB = 3 legs; 2 successful = 10GB).
 *
 * See TEMP-AUDIT-REMOVAL.md for how to take this out again.
 */
const Transaction = require('../models/TransactionModel');
const Product     = require('../models/ProductsModal');
require('../models/UserModel'); // registers 'user' for .populate

const PER_PAGE    = 100;
const MAX_PAGES   = 80;
const PAGE_GAP_MS = 300;

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** "1 Failed 2 Successful and 0 Unsure" -> { failed, ok, unsure, legs } */
function parseLegs(apiResponse) {
  const m = String(apiResponse || '').match(/(\d+)\s*Failed\s+(\d+)\s*Successful\s+and\s+(\d+)\s*Unsure/i);
  if (!m) return null;
  const failed = +m[1], ok = +m[2], unsure = +m[3];
  return { failed, ok, unsure, legs: failed + ok + unsure };
}

/** "15GB Data Plan" / "15GB" -> 15 */
function gbOf(text) {
  const m = String(text || '').match(/([\d.]+)\s*GB/i);
  return m ? parseFloat(m[1]) : null;
}


/**
 * The OurDataStore transaction id for one of our transactions. It lives in
 * three different places depending on when and how the purchase completed:
 *
 *   requestId      current path — added by buyData to the provider response
 *   'request-id'   July rows — the provider's own field name, before buyData
 *                  started attaching its own camelCase copy
 *   _odsTransid    timed-out purchases — the response was never stored, but the
 *                  poller recorded the id when it later confirmed delivery
 *
 * Checking all three lifts coverage from ~2,435 to ~3,106 of 3,127 successful
 * transactions. The remainder are admin adjustments and BitToken transfers,
 * which have no provider record at all.
 */
function odsKeyOf(tx) {
  const ar = tx.apiResponse || {};
  return ar.requestId || ar['request-id'] || ar._odsTransid || null;
}

async function runAudit({ onProgress } = {}) {
  // Required lazily: the module reads site settings from Mongo on first use.
  const { fetchDataTransactions } = require('./ourdatastore');

  const odsByTransid = new Map();
  let page = 1, pages = null;

  while (page <= MAX_PAGES) {
    const r = await fetchDataTransactions({ page, status: 'ALL', perPage: PER_PAGE });
    const rows = r.data || [];
    if (pages === null) pages = r.last_page || 1;
    rows.forEach(x => { if (x.transid) odsByTransid.set(String(x.transid), x); });
    if (onProgress) onProgress(page, Math.min(pages, MAX_PAGES), odsByTransid.size);
    if (!rows.length || page >= pages) break;
    page++;
    await sleep(PAGE_GAP_MS);
  }

  const products = await Product.find({ category: 'DATA' }).lean();
  const byId = new Map(products.map(p => [String(p._id), p]));

  const ours = await Transaction.find({ status: 'success' })
    .select('reference phone amount createdAt apiResponse product user')
    .populate('user', 'username email')
    .lean();

  const short = [];
  const stats = {
    ourSuccesses: ours.length,
    joined: 0, noRequestId: 0, notInOds: 0, singleLeg: 0, splitAllOk: 0,
    odsRows: odsByTransid.size,
  };

  for (const tx of ours) {
    const rid = odsKeyOf(tx);
    if (!rid) { stats.noRequestId++; continue; }

    const row = odsByTransid.get(String(rid));
    if (!row) { stats.notInOds++; continue; }
    stats.joined++;

    const legs = parseLegs(row.api_response);
    if (!legs) { stats.singleLeg++; continue; }
    if (legs.failed === 0) { stats.splitAllOk++; continue; }

    const prod = tx.product ? byId.get(String(tx.product)) : null;
    const boughtGb = gbOf(prod && prod.dataDetails && prod.dataDetails.plan_type) || gbOf(row.plan_name);
    const perLeg = boughtGb && legs.legs ? boughtGb / legs.legs : null;
    const deliveredGb = perLeg != null ? perLeg * legs.ok : null;
    const missingGb = boughtGb != null && deliveredGb != null ? boughtGb - deliveredGb : null;
    const lostValue = boughtGb && missingGb != null
      ? Math.round((tx.amount / boughtGb) * missingGb) : null;

    short.push({
      date: tx.createdAt,
      reference: tx.reference,
      transid: String(rid),
      phone: tx.phone || '',
      username: tx.user ? tx.user.username : '',
      email: tx.user ? tx.user.email : '',
      amountPaid: tx.amount || 0,
      boughtGb, deliveredGb, missingGb,
      legs: legs.legs, legsOk: legs.ok, legsFailed: legs.failed, legsUnsure: legs.unsure,
      lostValue: lostValue || 0,
      planType: (prod && prod.dataDetails && prod.dataDetails.plan_type) || row.plan_name || '',
      network: (prod && prod.dataDetails && prod.dataDetails.network) || row.network || '',
      odsMessage: row.api_response || '',
    });
  }

  short.sort((a, b) => new Date(b.date) - new Date(a.date));

  const totals = {
    rows: short.length,
    customers: new Set(short.map(r => r.email).filter(Boolean)).size,
    paidOnAffected: short.reduce((s, r) => s + r.amountPaid, 0),
    missingGb: short.reduce((s, r) => s + (r.missingGb || 0), 0),
    lostValue: short.reduce((s, r) => s + r.lostValue, 0),
  };

  return { short, totals, stats, generatedAt: new Date() };
}


/**
 * Checks ONE transaction for short delivery, using a targeted provider search
 * rather than the full history sweep. One API request instead of ~48, so this
 * is cheap enough to run continuously in the background.
 *
 * Returns:
 *   null                              not applicable / could not determine
 *   { short:false }                   delivered in full
 *   { short:true, boughtGb, ... }     partially delivered
 */
async function checkOne(tx, { productById } = {}) {
  const { fetchDataTransactions } = require('./ourdatastore');

  const key = odsKeyOf(tx);
  if (!key || !tx.phone) return null;

  // Only bundles large enough to be split into legs can be short-delivered.
  let prod = null;
  if (productById && tx.product) prod = productById.get(String(tx.product));
  if (!prod && tx.product) prod = await Product.findById(tx.product).lean();

  const boughtGb = gbOf(prod && prod.dataDetails && prod.dataDetails.plan_type);
  if (!boughtGb || boughtGb <= 5) return null;

  // Search by the last 10 digits of the phone — the provider stores numbers in
  // several formats (0803…, 234803…), so a substring match is more reliable
  // than an exact one.
  const needle = String(tx.phone).replace(/\D/g, '').slice(-10);
  let row = null;
  try {
    const r = await fetchDataTransactions({ page: 1, status: 'ALL', perPage: 100, search: needle });
    row = (r.data || []).find(x => String(x.transid) === String(key)) || null;
  } catch (err) {
    // Unreachable is not a verdict. Leave the transaction unstamped so it is
    // retried, rather than recording it as delivered in full.
    return null;
  }
  if (!row) return null;

  const legs = parseLegs(row.api_response);
  if (!legs) return { short: false };          // single leg, nothing to split
  if (legs.failed === 0) return { short: false };

  const perLeg = boughtGb / legs.legs;
  const deliveredGb = perLeg * legs.ok;
  const missingGb = boughtGb - deliveredGb;

  return {
    short: true,
    boughtGb,
    deliveredGb,
    missingGb,
    legs: legs.legs,
    legsOk: legs.ok,
    legsFailed: legs.failed,
    legsUnsure: legs.unsure,
    lostValue: Math.round((tx.amount / boughtGb) * missingGb),
    odsMessage: row.api_response || '',
    transid: String(key),
    planType: (prod && prod.dataDetails && prod.dataDetails.plan_type) || row.plan_name || '',
    network: (prod && prod.dataDetails && prod.dataDetails.network) || row.network || '',
  };
}

/**
 * The bundle that would make good a shortfall: same plan family, same validity,
 * exactly the missing volume.
 *
 * Returns null when no such bundle exists — AIRTEL, for example, has no 5GB
 * (its ladder is 1.5/2/3/4/10GB), so a short-delivered AIRTEL 10GB cannot be
 * topped up exactly and has to be refunded instead. The caller must handle that
 * rather than assume a top-up is always possible.
 */
// ODS only — this whole short-delivery audit is OurDataStore's leg-splitting
// quirk with no confirmed GSubz analogue (see transactionPoller.js's
// pollShortDelivery). Excluding GSUBZ-provider products here matters beyond
// consistency: two providers' plans could share a `network` brand name (each
// is only unique within its own collection), so without this filter a
// shortfall detected on an ODS order could resolve its top-up bundle from an
// unrelated GSubz plan of the same name and route the top-up through the
// wrong provider.
async function findTopUpProduct(network, missingGb) {
  if (!network || !missingGb) return null;
  const candidates = await Product.find({
    category: 'DATA',
    'dataDetails.network': network,
    'dataDetails.provider': { $ne: 'GSUBZ' },
  }).lean();
  return candidates.find(p => gbOf(p.dataDetails && p.dataDetails.plan_type) === missingGb) || null;
}

module.exports = { runAudit, parseLegs, gbOf, odsKeyOf, checkOne, findTopUpProduct };
