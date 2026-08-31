const axios = require('axios');

const BASE_URL = 'https://api.gsubz.com/api';

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

module.exports = { fetchPlans };
