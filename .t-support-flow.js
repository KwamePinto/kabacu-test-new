/* Drives Support & Reports against the real running app: loads the page, files
 * a report, and checks the email that would go out. Mailer stubbed so nothing
 * leaves the machine.
 */
require('dotenv').config();

const URI = process.env.MONGO_URI;
if (!URI || /genjpyi/.test(URI)) { console.log('bad or live URI'); process.exit(1); }

const emailPath = require.resolve('./server/utils/emailService');
const SENT = [];
require.cache[emailPath] = {
  id: emailPath, filename: emailPath, loaded: true, children: [], paths: [],
  exports: async function (opts) { SENT.push(opts); return { messageId: 'stubbed' }; },
};

const PORT = 3988;
process.env.PORT = String(PORT);

const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

const jar = {};
function putCookies(res) {
  (res.headers.getSetCookie ? res.headers.getSetCookie() : []).forEach((c) => {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    const k = pair.slice(0, i).trim();
    const v = pair.slice(i + 1).trim();
    if (!v) delete jar[k]; else jar[k] = v;
  });
}
const cookieHeader = () => Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ');
const BASE = 'http://127.0.0.1:' + PORT;

async function req(path, opts = {}) {
  const res = await fetch(BASE + path, {
    method: opts.method || 'GET',
    redirect: 'manual',
    headers: Object.assign({ Cookie: cookieHeader() }, opts.headers || {}),
    body: opts.body,
  });
  putCookies(res);
  const body = (res.status === 301 || res.status === 302) ? '' : await res.text();
  return { status: res.status, location: res.headers.get('location'), body };
}
const csrfFrom = (h) => (h.match(/name="_csrf"\s+value="([^"]*)"/) || [])[1] || '';
const jsCsrfFrom = (h) => (h.match(/var CSRF\s*=\s*'([^']*)'/) || [])[1] || '';

const EMAIL = 'zz-support-test@example.com';
const PASSWORD = 'TestPassw0rd!x';

(async () => {
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 20000 });
  const UserAdmin = require('./server/models/UserAdminModel');
  const BugReport = require('./server/models/BugReportModel');

  await UserAdmin.deleteMany({ email: EMAIL });
  const admin = await UserAdmin.create({
    username: 'zzsupport', email: EMAIL,
    password: await bcrypt.hash(PASSWORD, 10),
    role: 'super_admin', profileCompleted: true, isActive: true,
  });
  console.log('  admin: ' + EMAIL + '  2fa=' + admin.twoFactorEnabled + '\n');

  require('./app.js');
  await new Promise((r) => setTimeout(r, 2500));

  console.log('── sign in ──');
  const login = await req('/command');
  const done = await req('/command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      _csrf: csrfFrom(login.body), email: EMAIL, password: PASSWORD, role: 'super_admin',
    }).toString(),
  });
  ok('signed in', done.status === 302 && String(done.location).startsWith('/admin'),
     done.status + ' ' + done.location);

  console.log('\n── GET /admin/support ──');
  const page = await req('/admin/support');
  console.log('  status ' + page.status + (page.location ? '  -> ' + page.location : ''));
  ok('the page returns 200', page.status === 200,
     page.status + ' ' + (page.location || ''));

  if (page.status !== 200) {
    // Show whatever the server rendered instead — usually the error page.
    console.log('  body starts: ' + page.body.slice(0, 300).replace(/\s+/g, ' '));
  } else {
    ok('the drawer has all three sections',
       page.body.includes('data-section="dev-info"')
       && page.body.includes('data-section="create"')
       && page.body.includes('data-section="reports"'));
    ok('the default contact renders', page.body.includes('vkpinto1234@gmail.com'));
    ok('the report form is present',
       page.body.includes('id="rep-title"') && page.body.includes('id="rep-side"'));
    ok('a CSRF token reached the page JS', !!jsCsrfFrom(page.body), 'empty CSRF');
    ok('the panel stylesheet is linked',
       /kbc-panel\.css/.test(page.body), 'kbc-panel.css not referenced');
    ok('the drawer script is linked',
       /kbc-panel\.js/.test(page.body), 'kbc-panel.js not referenced');
  }

  console.log('\n── POST a report ──');
  await BugReport.deleteMany({ title: /^ZZFLOW/ });
  const token = jsCsrfFrom(page.body);
  const posted = await req('/admin/support/report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
    body: JSON.stringify({
      title: 'ZZFLOW test report',
      side: 'admin',
      page: 'Support & Reports',
      severity: 'high',
      description: 'Line one.\nLine two with <div> markup.',
    }),
  });
  console.log('  status ' + posted.status + '  ' + posted.body.slice(0, 220));

  let data = null;
  try { data = JSON.parse(posted.body); } catch (e) {}
  ok('the endpoint returns JSON', !!data, posted.body.slice(0, 160));
  ok('the report was accepted', data && data.success === true, JSON.stringify(data));
  ok('it was stored', (await BugReport.countDocuments({ title: /^ZZFLOW/ })) === 1);

  console.log('\n── the email ──');
  ok('an email was sent', SENT.length === 1, SENT.length + ' sent');
  if (SENT.length) {
    const m = SENT[0];
    console.log('  to     : ' + m.to);
    console.log('  subject: ' + m.subject);
    ok('addressed to the configured developer', m.to === 'vkpinto1234@gmail.com', m.to);
    ok('the subject names the side and title',
       /Admin dashboard/i.test(m.subject) && /ZZFLOW/.test(m.subject), m.subject);
    ok('the body carries the description', /Line two/.test(m.html));
    ok('markup in the description is escaped, not injected',
       m.html.includes('&lt;div&gt;') && !m.html.includes('<div> markup'));
    ok('line breaks are preserved', /Line one\.<br>/.test(m.html));
    ok('a plain-text alternative exists', !!m.text && /Line two/.test(m.text));
  }

  console.log('\n── the report shows in the list ──');
  const after = await req('/admin/support');
  ok('the new report appears on the page', after.body.includes('ZZFLOW test report'));

  await BugReport.deleteMany({ title: /^ZZFLOW/ });
  await UserAdmin.deleteMany({ email: EMAIL });
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.log('ERR ' + e.stack);
  try {
    await mongoose.connection.db.collection('useradmins').deleteMany({ email: EMAIL });
    await mongoose.connection.db.collection('bugreports').deleteMany({ title: /^ZZFLOW/ });
  } catch (x) {}
  process.exit(1);
});
