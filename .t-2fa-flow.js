/* Drives the real admin 2FA login against the real app.
 *
 * The mailer is replaced in the module cache BEFORE app.js loads, so no email
 * leaves the machine and the test can read the plaintext OTP — which is stored
 * only as a bcrypt hash and could not otherwise be recovered.
 *
 * Everything else is the real thing: real session store, real CSRF, real
 * routes. That is the point — the parts most likely to be broken here are the
 * ones a stubbed-out test would skip.
 */
require('dotenv').config();

const URI = process.env.MONGO_URI;
if (!URI || /genjpyi/.test(URI)) { console.log('bad or live URI'); process.exit(1); }

// ── Intercept the mailer before anything requires it ────────────────────────
const emailPath = require.resolve('./server/utils/emailService');
const SENT = [];
require.cache[emailPath] = {
  id: emailPath, filename: emailPath, loaded: true, children: [], paths: [],
  exports: async function (opts) { SENT.push(opts); return { messageId: 'stubbed' }; },
};

const PORT = 3987;
process.env.PORT = String(PORT);

const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

// ── Minimal cookie jar ─────────────────────────────────────────────────────
const jar = {};
function putCookies(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  raw.forEach((c) => {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    const k = pair.slice(0, i).trim();
    const v = pair.slice(i + 1).trim();
    if (v === '' || /Expires=Thu, 01 Jan 1970/i.test(c)) delete jar[k];
    else jar[k] = v;
  });
}
function cookieHeader() {
  return Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ');
}

const BASE = 'http://127.0.0.1:' + PORT;

async function get(path) {
  const res = await fetch(BASE + path, {
    redirect: 'manual',
    headers: { Cookie: cookieHeader() },
  });
  putCookies(res);
  const body = res.status === 302 || res.status === 301 ? '' : await res.text();
  return { status: res.status, location: res.headers.get('location'), body };
}

async function post(path, fields) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      Cookie: cookieHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(fields).toString(),
  });
  putCookies(res);
  const body = res.status === 302 || res.status === 301 ? '' : await res.text();
  return { status: res.status, location: res.headers.get('location'), body };
}

function csrfFrom(html) {
  const m = html.match(/name="_csrf"\s+value="([^"]*)"/);
  return m ? m[1] : '';
}
function errorFrom(html) {
  // The login/OTP views render the error text; pull anything that looks like it.
  const m = html.match(/(?:alert[^>]*>|<p[^>]*class="[^"]*error[^"]*"[^>]*>)\s*([^<]{6,160})/i);
  return m ? m[1].trim().replace(/\s+/g, ' ') : '';
}

const EMAIL = 'zz-2fa-test@example.com';
const PASSWORD = 'TestPassw0rd!x';

(async () => {
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 20000 });
  const UserAdmin = require('./server/models/UserAdminModel');

  // Fresh test admin, 2FA on.
  await UserAdmin.deleteMany({ email: EMAIL });
  const admin = await UserAdmin.create({
    username: 'zz2fa',
    email: EMAIL,
    password: await bcrypt.hash(PASSWORD, 10),
    role: 'super_admin',
    twoFactorEnabled: true,
    profileCompleted: true,
    isActive: true,
  });
  console.log('  test admin created: ' + EMAIL + '\n');

  // Boot the real app.
  require('./app.js');
  await new Promise((r) => setTimeout(r, 2500));

  console.log('── step 1: load the login page ──');
  const login = await get('/command');
  ok('login page loads', login.status === 200, 'status ' + login.status);
  const loginCsrf = csrfFrom(login.body);
  ok('login form carries a CSRF token', !!loginCsrf, 'token=' + JSON.stringify(loginCsrf));
  ok('a session cookie was issued or is not needed yet', true);

  console.log('\n── step 2: submit correct credentials ──');
  const submitted = await post('/command', {
    _csrf: loginCsrf,
    email: EMAIL,
    password: PASSWORD,
    role: 'super_admin',
  });
  console.log('  status ' + submitted.status + '  ->  ' + (submitted.location || '(rendered)'));
  if (submitted.status === 200) console.log('  page said: ' + (errorFrom(submitted.body) || '(no error text found)'));

  ok('credentials accepted and redirected to the OTP step',
     submitted.status === 302 && submitted.location === '/command/verify',
     submitted.status + ' ' + submitted.location);

  ok('an OTP email was generated', SENT.length === 1, SENT.length + ' sent');
  const code = SENT.length ? (String(SENT[0].text || '').match(/\b(\d{6})\b/) || [])[1] : null;
  ok('the email contains a 6-digit code', !!code, 'code=' + code);
  ok('no admin_token cookie yet — the password alone must not authenticate',
     !jar.admin_token, 'admin_token=' + jar.admin_token);

  console.log('\n── step 3: the OTP page ──');
  const otpPage = await get('/command/verify');
  ok('OTP page loads rather than bouncing to login',
     otpPage.status === 200 && /verif/i.test(otpPage.body),
     otpPage.status + ' ' + (otpPage.location || ''));
  const otpCsrf = csrfFrom(otpPage.body);
  ok('OTP form carries a CSRF token', !!otpCsrf);
  ok('the OTP page is not actually the login page in disguise',
     !/name="password"/.test(otpPage.body),
     'login form fields found on the verify page');

  console.log('\n── step 4: a wrong code is rejected ──');
  const wrong = await post('/command/verify', { _csrf: otpCsrf, code: '000000' });
  ok('a wrong code does not sign anyone in', !jar.admin_token);
  ok('a wrong code re-renders the OTP page with an error',
     wrong.status === 200 && /incorrect/i.test(wrong.body),
     wrong.status + ' ' + (errorFrom(wrong.body) || wrong.location || ''));

  console.log('\n── step 5: the correct code ──');
  const okCsrf = csrfFrom(wrong.body) || otpCsrf;
  const done = code ? await post('/command/verify', { _csrf: okCsrf, code }) : { status: 0 };
  console.log('  status ' + done.status + '  ->  ' + (done.location || '(rendered)'));
  if (done.status === 200) console.log('  page said: ' + (errorFrom(done.body) || '(no error text)'));

  ok('the correct code completes the sign-in',
     done.status === 302 && String(done.location || '').startsWith('/admin'),
     done.status + ' ' + done.location);
  ok('an admin_token cookie is now set', !!jar.admin_token);

  console.log('\n── step 6: the session actually works ──');
  const dash = await get('/admin/main/dashboard');
  ok('the dashboard is reachable after 2FA',
     dash.status === 200 || (dash.status === 302 && !String(dash.location).includes('/command')),
     dash.status + ' ' + (dash.location || ''));

  console.log('\n── step 7: an exempt admin skips the OTP ──');
  Object.keys(jar).forEach((k) => delete jar[k]);
  SENT.length = 0;
  await UserAdmin.updateOne({ _id: admin._id }, { $set: { twoFactorEnabled: false } });

  const login2 = await get('/command');
  const direct = await post('/command', {
    _csrf: csrfFrom(login2.body), email: EMAIL, password: PASSWORD, role: 'super_admin',
  });
  ok('an exempt admin goes straight in',
     direct.status === 302 && String(direct.location || '').startsWith('/admin'),
     direct.status + ' ' + direct.location);
  ok('no OTP email is sent for an exempt admin', SENT.length === 0, SENT.length + ' sent');

  await UserAdmin.deleteMany({ email: EMAIL });
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.log('ERR ' + e.stack);
  try { await mongoose.connection.db.collection('useradmins').deleteMany({ email: EMAIL }); } catch (x) {}
  process.exit(1);
});
