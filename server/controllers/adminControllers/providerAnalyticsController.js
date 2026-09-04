const { authenticateAdminUser } = require('../../config/authMiddleware');
const { fetchNetworkList, fetchDataPlans } = require('../../services/ourdatastore');
const gsubz = require('../../services/gsubz');
const logger = require('../../config/logger');

// Data-plan comparison across service providers (OurDataStore, GSubz, ...).
//
// OurDataStore: `network`/`network_type` (POST /api/get/data/plans/{adexId}/adex,
// same session auth as the transaction history calls) was reverse-engineered from
// the dashboard's own network requests and verified byte-for-byte against known
// plan lists before being trusted here. All three network_types were confirmed
// this way — note corporate gifting's real value is "cooperate gifting" (a space,
// not an underscore, and matching OurDataStore's own "COOPERATE" misspelling in
// plan names) — every grammatically-correct guess ('corporate_gifting', 'cg', ...)
// silently returns an empty list rather than an error, so this was NOT obvious.
//
// GSubz: service IDs are the same carrier -> category -> serviceID registry
// the admin GSubz plan-configuration UI is built from (server/services/
// gsubz.js's GSUBZ_CARRIER_CATEGORIES) — kept as one source of truth rather
// than a second copy here, so the two never drift when a service is
// activated/deactivated. Of the 11 GSubz IDs found on the dashboard, 5
// currently return "Service not found or inactive" on this account
// (mtn_cg_lite, mtn_coupon, mtncg, airtel_cg, etisalat_data) — not a
// wrong-value problem like ODS's corporate gifting was, the API itself says
// inactive, so they're left out of the registry rather than shown as empty.
const ODS_NETWORK_TYPES = [
  { value: 'sme',                label: 'SME',                flag: 'network_sme' },
  { value: 'gifting',             label: 'GIFTING',            flag: 'network_g' },
  { value: 'cooperate gifting',   label: 'CORPORATE GIFTING',  flag: 'network_cg' },
];

const GSUBZ_SERVICES = gsubz.GSUBZ_SERVICES;

function parsePlanSize(name) {
  const m = /^([\d.]+\s?(?:GB|MB))/i.exec(name || '');
  return m ? m[1].replace(/\s+/, '').toUpperCase() : (name || '').split(' ')[0] || '';
}

// Not always "whatever's in the first parens" — GLO's OurDataStore plan names
// put a day/night data-split breakdown there instead, e.g.
// "6GB GIFTING = ₦1,425.00 (4GB + 2GB*Night)-1week", with the real duration
// appended afterward. Searching the whole name for an actual duration token
// and taking the last match handles that, GSubz's "1GB - 30days" convention,
// and MTN/AIRTEL's simpler "(1month)" convention with one shared function.
function parsePlanDuration(name) {
  const matches = [...String(name || '').matchAll(/(\d+(?:\.\d+)?\s*(?:days|day|weeks|week|months|month))/gi)];
  if (!matches.length) return '';
  // Source formatting varies ("30days" vs "1 Month") — normalize to a single
  // space so the comparison table reads consistently across both providers.
  return matches[matches.length - 1][1].replace(/\s+/g, ' ').replace(/(\d)([a-z])/i, '$1 $2').trim();
}

async function fetchOdsPlans() {
  const networks = await fetchNetworkList();

  const jobs = [];
  for (const net of networks) {
    for (const type of ODS_NETWORK_TYPES) {
      if (!net[type.flag]) continue; // provider itself says this network doesn't offer this plan type
      jobs.push({ net, type });
    }
  }

  // allSettled, not all: one network/type combo failing (rate limit, a
  // transient 403, etc.) must not throw away every other combo that
  // succeeded — that already happened once during testing and silently
  // zeroed out the whole provider's data for that page load.
  const settled = await Promise.allSettled(
    jobs.map(({ net, type }) => fetchDataPlans({ network: net.plan_id, networkType: type.value }))
  );

  const rows = [];
  settled.forEach((result, i) => {
    const { net, type } = jobs[i];
    if (result.status === 'rejected') {
      logger.warn(`[PROVIDER ANALYTICS] OurDataStore ${net.network}/${type.label} plans fetch failed: ${result.reason?.message || result.reason}`);
      return;
    }
    for (const p of result.value) {
      rows.push({
        network:  net.network,
        type:     type.label,
        size:     parsePlanSize(p.name),
        duration: parsePlanDuration(p.name),
        price:    Number(p.amount),
      });
    }
  });
  return rows;
}

async function fetchGsubzPlans() {
  const settled = await Promise.allSettled(
    GSUBZ_SERVICES.map((cfg) => gsubz.fetchPlans(cfg.service))
  );

  const rows = [];
  settled.forEach((result, i) => {
    const cfg = GSUBZ_SERVICES[i];
    if (result.status === 'rejected') {
      logger.warn(`[PROVIDER ANALYTICS] GSubz ${cfg.network}/${cfg.label} plans fetch failed: ${result.reason?.message || result.reason}`);
      return;
    }
    for (const p of result.value) {
      rows.push({
        network:  cfg.network,
        type:     cfg.label,
        size:     parsePlanSize(p.displayName),
        duration: parsePlanDuration(p.displayName),
        // api_price (what /pay actually charges) rather than price (the
        // higher, suggested-resale figure) — this page compares what we'd
        // actually pay each provider, not their display pricing.
        price:    Number(p.api_price),
      });
    }
  });
  return rows;
}

const PROVIDERS = [
  {
    key: 'ourdatastore',
    label: 'OurDataStore',
    fetchPlans: fetchOdsPlans,
  },
  {
    key: 'gsubz',
    label: 'GSubz',
    fetchPlans: fetchGsubzPlans,
    note: 'Corporate Gifting and 9mobile data are not shown — those service IDs currently return "inactive" on this GSubz account.',
  },
];

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');

function sizeToMB(size) {
  const m = /([\d.]+)\s*(GB|MB)/i.exec(size || '');
  if (!m) return 0;
  const n = parseFloat(m[1]);
  return /GB/i.test(m[2]) ? n * 1024 : n;
}

// Identifies "the same plan" across providers: same network, same plan type
// (SME/Gifting/...), same size, same duration. Duration is normalized only
// for case/whitespace, NOT unit-equivalence — OurDataStore phrases a monthly
// plan "1 month" while GSubz phrases the same idea "30 days", and those are
// deliberately kept as separate rows rather than guessed to be identical,
// since "30 days" and "1 calendar month" aren't always the same plan in this
// industry. A size/duration filter still finds both regardless.
function planKey(row) {
  return [norm(row.network), norm(row.type), norm(row.size), norm(row.duration)].join('|');
}

exports.viewDashboard = [
  authenticateAdminUser,
  async (req, res) => {
    const query = (req.query.q || '').trim();

    // Distinguishes "form submitted with every box unchecked" from "page
    // never touched yet" — both leave req.query.providers empty/undefined,
    // but only the first should mean "compare nothing."
    const submitted = req.query.providersSubmitted === '1';
    const requestedKeys = [].concat(req.query.providers || []);
    const selectedKeys = submitted
      ? requestedKeys
      : PROVIDERS.map((p) => p.key); // fresh visit — compare everything by default

    const toFetch = PROVIDERS.filter((p) => selectedKeys.includes(p.key));

    const results = await Promise.all(toFetch.map(async (provider) => {
      if (typeof provider.fetchPlans !== 'function') {
        return { ...provider, plans: [], pending: true };
      }
      try {
        const plans = await provider.fetchPlans();
        return { ...provider, plans, pending: false };
      } catch (err) {
        return { ...provider, plans: [], pending: true, pendingReason: err.message };
      }
    }));

    // Pivot into one row per unique plan, one column per selected provider —
    // a plan only one provider carries still gets a row, with "-" for
    // whichever provider(s) don't have it.
    const grouped = new Map();
    results.forEach((provider) => {
      provider.plans.forEach((plan) => {
        const key = planKey(plan);
        if (!grouped.has(key)) {
          grouped.set(key, {
            network: plan.network, type: plan.type || '', size: plan.size, duration: plan.duration,
            prices: {},
          });
        }
        grouped.get(key).prices[provider.key] = plan.price;
      });
    });

    let comparisonRows = Array.from(grouped.values());

    if (query) {
      // Size matches exactly (normalized) — otherwise typing "2gb" would also
      // match "3.2GB", "12GB", "20GB", etc. Plan name (network + type, e.g.
      // "MTN SME") matches by substring so "sme" or "mtn" both work.
      const q = norm(query);
      comparisonRows = comparisonRows.filter((r) =>
        norm(r.size) === q || norm(r.network + r.type).includes(q)
      );
    }

    comparisonRows.sort((a, b) =>
      norm(a.network).localeCompare(norm(b.network)) ||
      sizeToMB(a.size) - sizeToMB(b.size) ||
      norm(a.type).localeCompare(norm(b.type)) ||
      norm(a.duration).localeCompare(norm(b.duration))
    );

    res.render('adminview/providerAnalytics', {
      layout: 'layouts/adminLayout',
      allProviders: PROVIDERS.map((p) => ({ key: p.key, label: p.label })),
      selectedProviders: results,
      selectedKeys,
      comparisonRows,
      query,
    });
  },
];
