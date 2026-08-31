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
// GSubz: service IDs were captured directly from the GSubz dashboard's page
// source (their own docs never publish which IDs carry data plans — see
// gsubz_doc.md) and verified live. Of the 11 found, 5 currently return
// "Service not found or inactive" on this account (mtn_cg_lite, mtn_coupon,
// mtncg, airtel_cg, etisalat_data) — not a wrong-value problem like ODS's
// corporate gifting was, the API itself says inactive, so they're left out
// rather than shown as empty. Re-check if GSubz activates them later.
const ODS_NETWORK_TYPES = [
  { value: 'sme',                label: 'SME',                flag: 'network_sme' },
  { value: 'gifting',             label: 'GIFTING',            flag: 'network_g' },
  { value: 'cooperate gifting',   label: 'CORPORATE GIFTING',  flag: 'network_cg' },
];

const GSUBZ_SERVICES = [
  { service: 'mtn_sme',       network: 'MTN',    label: 'SME' },
  { service: 'mtn_gifting',   network: 'MTN',    label: 'GIFTING' },
  { service: 'mtn_datashare', network: 'MTN',    label: 'DATA SHARE' },
  { service: 'airtel_sme',    network: 'AIRTEL', label: 'SME' },
  { service: 'glo_data',      network: 'GLO',    label: 'DATA' },
  { service: 'glo_sme',       network: 'GLO',    label: 'SME' },
];

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

exports.viewDashboard = [
  authenticateAdminUser,
  async (req, res) => {
    const query = (req.query.q || '').trim();

    const results = await Promise.all(PROVIDERS.map(async (provider) => {
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

    // Flatten into one comparable list: { provider, network, size, duration, price }.
    // Filtering is substring-based against "size duration" together, so typing
    // "2gb" matches "2GB" plans regardless of duration, and "30 days" narrows
    // further within that.
    let rows = results.flatMap((provider) =>
      provider.plans.map((plan) => ({
        providerKey:   provider.key,
        providerLabel: provider.label,
        network:       plan.network,
        type:          plan.type || '',
        size:          plan.size,
        duration:      plan.duration,
        price:         plan.price,
      }))
    );

    if (query) {
      // Size matches exactly (normalized), not by substring — otherwise typing
      // "2gb" would also match "3.2GB", "12GB", "20GB", etc. Duration and
      // network stay substring-friendly since those are free text.
      const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');
      const q = norm(query);
      rows = rows.filter((r) =>
        norm(r.size) === q ||
        norm(r.duration).includes(q) ||
        norm(r.network).includes(q)
      );
    }

    res.render('adminview/providerAnalytics', {
      layout: 'layouts/adminLayout',
      providers: results,
      rows,
      query,
    });
  },
];
