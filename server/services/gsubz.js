const axios  = require('axios');
const logger = require('../config/logger');

const BASE_URL = 'https://api.gsubz.com/api';

// Carrier -> category -> serviceID registry. GSubz has no discovery endpoint
// for which serviceIDs exist per carrier, so this is the single source of
// truth for both the admin plan-configuration UI (server/controllers/
// adminControllers/networksController.js) and the purchase dispatcher
// (server/services/dataProviders.js) -- an admin can only ever pick from
// what's listed here, never free-type a serviceID.
//
// Captured directly from the GSubz dashboard's page source (their own docs
// never publish which IDs carry data plans) and verified live before being
// trusted here. Of 11 found, 5 are confirmed INACTIVE on this account (same
// "Service not found or inactive" error regardless of spelling -- a real
// account-activation gap, not a naming problem): mtn_cg_lite, mtn_coupon,
// mtncg, airtel_cg, etisalat_data. Re-check if GSubz activates them later --
// 9mobile has no working category at all yet, hence the empty array.
const GSUBZ_CARRIER_CATEGORIES = {
  MTN: [
    { key: 'sme',       label: 'SME',       serviceID: 'mtn_sme' },
    { key: 'gifting',   label: 'GIFTING',   serviceID: 'mtn_gifting' },
    { key: 'datashare', label: 'DATA SHARE',serviceID: 'mtn_datashare' },
  ],
  GLO: [
    { key: 'sme',  label: 'SME',  serviceID: 'glo_sme' },
    { key: 'data', label: 'DATA', serviceID: 'glo_data' },
  ],
  AIRTEL: [
    { key: 'sme', label: 'SME', serviceID: 'airtel_sme' },
  ],
  '9MOBILE': [],
};

// Flat view for callers that just want {service, network, label} rows rather
// than the carrier grouping -- kept so providerAnalyticsController.js has one
// source of truth instead of maintaining its own separate copy of this list.
const GSUBZ_SERVICES = Object.entries(GSUBZ_CARRIER_CATEGORIES).flatMap(
  ([network, categories]) => categories.map((c) => ({ service: c.serviceID, network, label: c.label }))
);

function findService(carrier, categoryKey) {
  const categories = GSUBZ_CARRIER_CATEGORIES[String(carrier || '').toUpperCase()] || [];
  return categories.find((c) => c.key === categoryKey) || null;
}

// GSubz's own docs never publish which service IDs carry data plans (their
// examples use airtime-only IDs like "mtn", which return an empty plan list).
// These were captured directly from the GSubz dashboard's page source, not
// guessed, and verified live before being trusted here.
async function fetchPlans(service) {
  const key = process.env.Gsubz_API_KEY;
  const r = await axios.get(`${BASE_URL}/plans`, {
    params:  { service },
    headers: { Authorization: `Bearer ${key}` },
    timeout: 15000,
  });
  if (r.data?.error) throw new Error(r.data.error);
  return r.data?.plans || [];
}

// ── POST helper ───────────────────────────────────────────
// GSubz's /pay and /verify need application/x-www-form-urlencoded bodies --
// live testing against /api/testpay/ showed a raw JSON body is silently
// misread (PHP's $_POST doesn't populate from a JSON body), not rejected
// outright, so it fails in a way that looks like a missing-field bug rather
// than a wrong-content-type one. See gsubz_doc.md §5 for the full writeup.
//
// The trailing slash on the path is NOT cosmetic: gsubz.com/api/pay (no
// slash) 301-redirects to gsubz.com/api/pay/, and a 301 on a POST is
// followed as a GET by both browsers and Node's fetch/axios -- so an
// un-slashed URL doesn't error, it silently sends the wrong HTTP method and
// comes back 200 REQUEST_METHOD_NOT_POST. Confirmed live on both gsubz.com
// and api.gsubz.com.
async function postForm(path, fields, { timeout = 15000 } = {}) {
  const key = process.env.Gsubz_API_KEY;
  const params = new URLSearchParams();
  Object.entries(fields).forEach(([k, v]) => {
    if (v !== undefined && v !== null) params.append(k, v);
  });
  return axios.post(`${BASE_URL}/${path}/`, params.toString(), {
    timeout,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });
}

// ── Helpers ───────────────────────────────────────────────
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Sequential request queue ──────────────────────────────
// Mirrors ourdatastore.js's queue exactly: one purchase at a time, so a burst
// of concurrent buyers can't trip whatever rate limit GSubz enforces (never
// published -- see gsubz_doc.md §6.3 -- so this is a defensive default from
// day one rather than something added after the first 429).
const queue      = [];
let isProcessing = false;
let lastCallTime = 0;
const MIN_GAP_MS = 1200;

async function processQueue() {
  if (isProcessing || queue.length === 0) return;
  isProcessing = true;

  while (queue.length > 0) {
    const { resolve, reject, params } = queue.shift();

    const gap = Date.now() - lastCallTime;
    if (gap < MIN_GAP_MS) await sleep(MIN_GAP_MS - gap);

    try {
      const result = await executeBuyData(params);
      lastCallTime = Date.now();
      resolve(result);
    } catch (err) {
      lastCallTime = Date.now();
      reject(err);
    }
  }

  isProcessing = false;
}

// ── Core API call with retry on rate-limit ────────────────
const MAX_RETRIES = 4;
const BASE_DELAY  = 2000; // 2s -> 4s -> 6s -> 8s

async function executeBuyData(params) {
  const { serviceID, plan, phone, amount, requestID } = params;

  logger.info(`[GSUBZ PURCHASE] Request — phone: ${phone}, serviceID: ${serviceID}, plan: ${plan}, reqId: ${requestID}`);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // No published rate limit and no confirmed retryable/terminal error
      // distinction yet (gsubz_doc.md §6.3, §6.5) -- 429 is the one signal
      // every provider in this codebase treats as retryable.
      //
      // Timeout set just under the caller's 60s Promise.race, same reasoning
      // as ourdatastore.js: on no response, this request gives up first, the
      // queue slot is released, and dataProviders.js classifies the outcome
      // as `pending` (ask before refunding) rather than a blind `fail`.
      const response = await postForm('pay', { serviceID, plan, phone, amount, requestID }, { timeout: 55000 });
      logger.info(`[GSUBZ PURCHASE] Response — ${JSON.stringify(response.data)}`);
      return response.data;
    } catch (error) {
      const status = error.response?.status;
      const isRateLimit = status === 429;

      logger.error(`[GSUBZ PURCHASE] Error — status: ${status || 'N/A'}, body: ${JSON.stringify(error.response?.data || {})}`);

      if (isRateLimit && attempt < MAX_RETRIES) {
        const wait = BASE_DELAY * attempt;
        logger.warn(`[GSUBZ PURCHASE] Rate limited – retrying in ${wait}ms (attempt ${attempt}/${MAX_RETRIES})`);
        await sleep(wait);
        continue;
      }

      throw error;
    }
  }
}

// ── Public API ────────────────────────────────────────────
// Deliberately symmetric with ourdatastore.js's buyData: resolves with the
// raw provider response body on any HTTP-level response, or throws on a
// network error/timeout. Classifying that into {status: success|fail|pending}
// is dataProviders.js's job (it needs to apply GSubz-specific rules --
// content.code === '000', not a top-level `status` field -- that ODS's raw
// response doesn't need), not something silently assumed here.
async function buyData({ serviceID, plan, phone, amount, requestID }) {
  return new Promise((resolve, reject) => {
    queue.push({ resolve, reject, params: { serviceID, plan, phone, amount, requestID } });
    processQueue();
  });
}

// Ask GSubz what actually happened to a transaction, by requestID. Built now
// so the manual admin "Check GSubz status" action has something to call, but
// deliberately NOT wired into the automatic poller yet -- /verify's
// pending/success response shapes have only been observed against the
// /testverify/ sandbox, never the live endpoint (gsubz_doc.md §6.2).
async function verify(requestID) {
  const response = await postForm('verify', { requestID }, { timeout: 15000 });
  return response.data;
}

module.exports = {
  fetchPlans,
  buyData,
  verify,
  findService,
  GSUBZ_CARRIER_CATEGORIES,
  GSUBZ_SERVICES,
};
