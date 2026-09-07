/**
 * Resolves which network carrier a DATA product runs on, independently of
 * which service provider fulfils it.
 *
 * A product names its plan in `dataDetails.network` — "CTC Weekly
 * Special-MTN" for OurDataStore, "MTN SME Special" for GSubz — and the
 * carrier has to be looked up from whichever catalogue owns that name:
 *
 *   provider ODS   -> NetworkModel.apiCode   (1 MTN / 2 GLO / 3 Airtel / 4 9mobile)
 *   provider GSUBZ -> GsubzPlanModel.carrier (already stores the carrier)
 *
 * Consulting only the ODS catalogue — which is what the data-category page
 * did before this util existed — leaves GSubz products relying on the
 * substring fallback, so a GSubz plan named without a carrier word in it
 * ("Weekend Blast") resolved to nothing. Reading both catalogues fixes that,
 * and gives the product card the token it needs to pick its carrier artwork.
 */
const CARRIERS = {
  mtn:       { label: 'MTN',     art: '/assets/images/Networks/mtn.png' },
  glo:       { label: 'GLO',     art: '/assets/images/Networks/glo.png' },
  airtel:    { label: 'Airtel',  art: '/assets/images/Networks/airtel.png' },
  // No artwork for 9mobile yet — the source folder has no 9mobile image, so
  // cards fall back to the plain background rather than showing nothing.
  '9mobile': { label: '9mobile', art: null },
};

const BY_API_CODE = { 1: 'mtn', 2: 'glo', 3: 'airtel', 4: '9mobile' };

// Both catalogues are tiny (tens of rows) and change only when an admin edits
// them, so one short-lived cache spares every product listing two queries.
const CACHE_TTL_MS = 5 * 60 * 1000;
let cache = null;

async function loadCarrierMaps({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.maps;

  const Network = require('../models/NetworkModel');
  const GsubzPlan = require('../models/GsubzPlanModel');

  const [networks, gsubzPlans] = await Promise.all([
    Network.find({}).select('name apiCode').lean(),
    GsubzPlan.find({}).select('name carrier').lean(),
  ]);

  const ods = new Map();
  networks.forEach((n) => {
    const key = BY_API_CODE[n.apiCode];
    if (key) ods.set(String(n.name).toUpperCase(), key);
  });

  const gsubz = new Map();
  gsubzPlans.forEach((p) => {
    const key = String(p.carrier || '').toLowerCase();
    if (CARRIERS[key]) gsubz.set(String(p.name).toUpperCase(), key);
  });

  const maps = { ods, gsubz };
  cache = { at: Date.now(), maps };
  return maps;
}

/**
 * Returns a carrier token ('mtn' | 'glo' | 'airtel' | '9mobile') or null.
 * Pass the maps from loadCarrierMaps() so a listing resolves in memory
 * instead of querying per product.
 */
function carrierOf(dataDetails, maps) {
  if (!dataDetails) return null;
  const name = String(dataDetails.network || '').toUpperCase();
  if (!name) return null;

  // The plan's own catalogue is authoritative; only fall back to guessing
  // from the name when the plan is not (or no longer) configured.
  if (dataDetails.provider === 'GSUBZ') {
    if (maps && maps.gsubz.has(name)) return maps.gsubz.get(name);
  } else if (maps && maps.ods.has(name)) {
    return maps.ods.get(name);
  }

  // Legacy/unconfigured plans: match the carrier out of the name. "CTC" is
  // treated as MTN because the original CTC-branded plans were all MTN, which
  // is the assumption ourdatastore.js's networkCode() already encodes.
  if (name.includes('MTN') || name.includes('CTC')) return 'mtn';
  if (name.includes('AIRTEL')) return 'airtel';
  if (name.includes('GLO')) return 'glo';
  if (name.includes('9MOBILE') || name.includes('ETISALAT')) return '9mobile';
  return null;
}

const carrierLabel = (token) => (CARRIERS[token] ? CARRIERS[token].label : 'Others');
const carrierArt = (token) => (CARRIERS[token] ? CARRIERS[token].art : null);

module.exports = { CARRIERS, loadCarrierMaps, carrierOf, carrierLabel, carrierArt };
