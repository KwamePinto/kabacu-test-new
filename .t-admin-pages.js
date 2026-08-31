/* Loads every admin panel page as a signed-in super admin and checks that each
 * one actually ships the JS it calls.
 *
 * A page that renders but whose buttons throw `Swal is not defined` looks
 * exactly like a page that is "not working at all", and nothing in a template
 * compile or an EJS render catches it — the call only fails in the browser.
 */
require('dotenv').config();

const URI = process.env.MONGO_URI;
if (!URI || /genjpyi/.test(URI)) { console.log('bad or live URI'); process.exit(1); }

const emailPath = require.resolve('./server/utils/emailService');
require.cache[emailPath] = {
  id: emailPath, filename: emailPath, loaded: true, children: [], paths: [],
  exports: async function () { return { messageId: 'stubbed' }; },
};

const PORT = 3989;
process.env.PORT = String(PORT);

const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const jar = {};
function putCookies(res) {
  (res.headers.getSetCookie ? res.headers.getSetCookie() : []).forEach((c) => {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    const k = pair.slice(0, i).trim(); const v = pair.slice(i + 1).trim();
    if (!v) delete jar[k]; else jar[k] = v;
  });
}
const cookieHeader = () => Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ');
const BASE = 'http://127.0.0.1:' + PORT;

async function req(path, opts = {}) {
  const res = await fetch(BASE + path, {
    method: opts.method || 'GET', redirect: 'manual',
    headers: Object.assign({ Cookie: cookieHeader() }, opts.headers || {}),
    body: opts.body,
  });
  putCookies(res);
  const body = (res.status === 301 || res.status === 302) ? '' : await res.text();
  return { status: res.status, location: res.headers.get('location'), body };
}
const csrfFrom = (h) => (h.match(/name="_csrf"\s+value="([^"]*)"/) || [])[1] || '';

const PAGES = [
  '/admin/main/dashboard',
  '/admin/support',
  '/admin/faq',
  '/admin/settings',
  '/admin/announcements',
  '/admin/referrals',
  '/admin/payments-wallets',
  '/admin/profile',
  '/admin/flagged-transactions',
  '/admin/networks',
  '/admin/push-notifications',
  '/admin/logs',
  '/admin/transactions',
  '/admin/profit',
  '/admin/admins',
  '/admin/ourdatastore',
  '/admin/gsubz',
  '/admin/provider-analytics',
  '/admin/category/view-category',
];

const EMAIL = 'zz-pages-test@example.com';
const PASSWORD = 'TestPassw0rd!x';

(async () => {
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 20000 });
  const UserAdmin = require('./server/models/UserAdminModel');
  await UserAdmin.deleteMany({ email: EMAIL });
  await UserAdmin.create({
    username: 'zzpages', email: EMAIL,
    password: await bcrypt.hash(PASSWORD, 10),
    role: 'super_admin', profileCompleted: true, isActive: true,
  });

  require('./app.js');
  await new Promise((r) => setTimeout(r, 2500));

  const login = await req('/command');
  const done = await req('/command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      _csrf: csrfFrom(login.body), email: EMAIL, password: PASSWORD, role: 'super_admin',
    }).toString(),
  });
  if (done.status !== 302) { console.log('could not sign in: ' + done.status); process.exit(1); }
  console.log('  signed in as super admin\n');

  let broken = 0;
  console.log('  page                            status  drawer  Swal used  Swal loaded');
  console.log('  ' + '-'.repeat(74));

  for (const path of PAGES) {
    const r = await req(path);
    const h = r.body;

    const usesDrawer  = h.includes('kp-drawer__item');
    const drawerJs    = h.includes('kbc-panel.js');
    const usesSwal    = /\bSwal\s*\.\s*fire/.test(h);
    // Either the v11 CDN build or any script that defines the global.
    const swalLoaded  = /sweetalert2/.test(h);

    const problems = [];
    if (r.status !== 200) problems.push('status ' + r.status + (r.location ? ' -> ' + r.location : ''));
    if (usesDrawer && !drawerJs) problems.push('drawer JS missing');
    if (usesSwal && !swalLoaded) problems.push('Swal.fire used but sweetalert2 not loaded');

    if (problems.length) broken++;
    console.log('  ' + path.padEnd(32)
      + String(r.status).padEnd(8)
      + (usesDrawer ? (drawerJs ? 'ok    ' : 'MISS  ') : '-     ')
      + (usesSwal ? 'yes        ' : 'no         ')
      + (usesSwal ? (swalLoaded ? 'ok' : 'MISSING') : '-')
      + (problems.length ? '   <-- ' + problems.join('; ') : ''));
  }

  console.log('\n  ' + (broken ? broken + ' page(s) with problems' : 'every page clean'));

  await UserAdmin.deleteMany({ email: EMAIL });
  await mongoose.disconnect();
  process.exit(broken ? 1 : 0);
})().catch(async (e) => {
  console.log('ERR ' + e.stack);
  try { await mongoose.connection.db.collection('useradmins').deleteMany({ email: EMAIL }); } catch (x) {}
  process.exit(1);
});
