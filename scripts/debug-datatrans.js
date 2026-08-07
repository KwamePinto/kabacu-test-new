require('dotenv').config();
const axios  = require('axios');
const { wrapper }   = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');

const BASE_URL = 'https://ourdatastore.com/api';

async function run() {
  // Step 1: login to get session cookies + adex id
  console.log('Logging in...');
  const jar    = new CookieJar();
  const client = wrapper(axios.create({ jar, withCredentials: true }));

  const loginRes = await client.post('https://ourdatastore.com/api/login/verify/user',
    { username: process.env.OURDATASTORE_USERNAME, password: process.env.OURDATASTORE_PASSWORD },
    { headers: { 'Content-Type': 'application/json', Accept: 'application/json',
                 Origin: 'https://app.ourdatastore.com', Referer: 'https://app.ourdatastore.com/' } }
  );
  console.log('Login response status:', loginRes.status);
  console.log('Login response data keys:', Object.keys(loginRes.data || {}));
  console.log('Login token (adex id):', loginRes.data?.token);

  const adexId = loginRes.data?.token;
  const cookies = await jar.getCookies('https://ourdatastore.com');
  const cookieHeader = cookies.map(c => `${c.key}=${c.value}`).join('; ');

  // Step 2: hit datatrans endpoint
  console.log('\nFetching datatrans...');
  const url = `https://ourdatastore.com/api/system/all/datatrans/adex/${adexId}/secure`;
  console.log('URL:', url);

  const r = await axios.get(url, {
    params: { page: 0, adex: 5, status: 'ALL', search: '' },
    headers: {
      Cookie: cookieHeader,
      Accept: 'application/json',
      Origin: 'https://app.ourdatastore.com',
      Referer: 'https://app.ourdatastore.com/',
      'User-Agent': 'Mozilla/5.0',
    },
  });

  console.log('\nResponse status:', r.status);
  console.log('Top-level keys:', Object.keys(r.data || {}));

  // Print structure of first level
  for (const [key, val] of Object.entries(r.data || {})) {
    if (Array.isArray(val)) {
      console.log(`  ${key}: Array[${val.length}]`, val.length > 0 ? '— first item keys: ' + Object.keys(val[0]).join(', ') : '');
    } else if (val && typeof val === 'object') {
      console.log(`  ${key}: Object — keys: ${Object.keys(val).join(', ')}`);
      if (val.data && Array.isArray(val.data)) {
        console.log(`    .data: Array[${val.data.length}]`, val.data.length > 0 ? '— first item keys: ' + Object.keys(val.data[0]).join(', ') : '(empty)');
        if (val.data.length > 0) {
          console.log('    first item:', JSON.stringify(val.data[0], null, 2));
        }
      }
    } else {
      console.log(`  ${key}:`, val);
    }
  }
}

run().catch(err => {
  console.error('Error:', err.response?.status, err.response?.data || err.message);
  process.exit(1);
});
