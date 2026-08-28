/* Drives the new Support & Reports flow against the real running app:
 * add/remove developers (super admin only), file a report with a screenshot
 * attached and a developer assigned, remind, and the fixed/unfixed toggle.
 * Mailer stubbed so nothing leaves the machine.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const URI = process.env.MONGO_URI;
if (!URI || /genjpyi/.test(URI)) { console.log('bad or live URI'); process.exit(1); }

const emailPath = require.resolve('./server/utils/emailService');
const SENT = [];
require.cache[emailPath] = {
  id: emailPath, filename: emailPath, loaded: true, children: [], paths: [],
  exports: async function (opts) { SENT.push(opts); return { messageId: 'stubbed' }; },
};

const PORT = 3990;
process.env.PORT = String(PORT);

const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

const jars = {};
function jar(who) { return jars[who] || (jars[who] = {}); }
function putCookies(who, res) {
  (res.headers.getSetCookie ? res.headers.getSetCookie() : []).forEach((c) => {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    const k = pair.slice(0, i).trim(); const v = pair.slice(i + 1).trim();
    if (!v) delete jar(who)[k]; else jar(who)[k] = v;
  });
}
const cookieHeader = (who) => Object.entries(jar(who)).map(([k, v]) => k + '=' + v).join('; ');
const BASE = 'http://127.0.0.1:' + PORT;

async function req(who, path, opts = {}) {
  const res = await fetch(BASE + path, {
    method: opts.method || 'GET', redirect: 'manual',
    headers: Object.assign({ Cookie: cookieHeader(who) }, opts.headers || {}),
    body: opts.body,
  });
  putCookies(who, res);
  const body = (res.status === 301 || res.status === 302) ? '' : await res.text();
  return { status: res.status, location: res.headers.get('location'), body };
}
const csrfFrom = (h) => (h.match(/name="_csrf"\s+value="([^"]*)"/) || [])[1] || '';
const jsCsrfFrom = (h) => (h.match(/var CSRF\s*=\s*'([^']*)'/) || [])[1] || '';

async function signIn(who, email, password, role) {
  const login = await req(who, '/command');
  return req(who, '/command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      _csrf: csrfFrom(login.body), email, password, role,
    }).toString(),
  });
}

const SUPER_EMAIL = 'zz-support-super@example.com';
const JUNIOR_EMAIL = 'zz-support-junior@example.com';
const PASSWORD = 'TestPassw0rd!x';

(async () => {
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 20000 });
  const UserAdmin = require('./server/models/UserAdminModel');
  const BugReport = require('./server/models/BugReportModel');
  const Developer = require('./server/models/DeveloperModel');

  await UserAdmin.deleteMany({ email: { $in: [SUPER_EMAIL, JUNIOR_EMAIL] } });
  await UserAdmin.create({
    username: 'zzsupportsuper', email: SUPER_EMAIL,
    password: await bcrypt.hash(PASSWORD, 10),
    role: 'super_admin', profileCompleted: true, isActive: true,
  });
  await UserAdmin.create({
    username: 'zzsupportjunior', email: JUNIOR_EMAIL,
    password: await bcrypt.hash(PASSWORD, 10),
    role: 'junior_admin', profileCompleted: true, isActive: true,
  });
  await Developer.deleteMany({ email: /zz-dev/ });
  await BugReport.deleteMany({ title: /^ZZFLOW2/ });

  require('./app.js');
  await new Promise((r) => setTimeout(r, 2500));

  const s1 = await signIn('super', SUPER_EMAIL, PASSWORD, 'super_admin');
  ok('super admin signed in', s1.status === 302, s1.status + ' ' + s1.location);
  const j1 = await signIn('junior', JUNIOR_EMAIL, PASSWORD, 'junior_admin');
  ok('junior admin signed in', j1.status === 302, j1.status + ' ' + j1.location);

  console.log('\n── developer CRUD, gated to super admin ──');
  const pageAsSuper = await req('super', '/admin/support');
  const csrfSuper = jsCsrfFrom(pageAsSuper.body);
  const pageAsJuniorEarly = await req('junior', '/admin/support');
  const csrfJuniorEarly = jsCsrfFrom(pageAsJuniorEarly.body);

  // A valid CSRF token, so this actually reaches the role check rather than
  // being bounced by the CSRF error handler first.
  const juniorAdd = await req('junior', '/admin/support/developers', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfJuniorEarly },
    body: JSON.stringify({ name: 'Should Fail', email: 'zz-dev-fail@example.com' }),
  });
  let juniorAddData = null;
  try { juniorAddData = JSON.parse(juniorAdd.body); } catch (e) {}
  ok('junior admin cannot add a developer', juniorAdd.status === 403, juniorAdd.status + ' ' + juniorAdd.body.slice(0, 120));

  const addDev = await req('super', '/admin/support/developers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfSuper },
    body: JSON.stringify({ name: 'ZZ Dev One', email: 'zz-dev-one@example.com', role: 'Backend' }),
  });
  let addDevData = null;
  try { addDevData = JSON.parse(addDev.body); } catch (e) {}
  ok('super admin can add a developer', addDevData && addDevData.success === true, addDev.body.slice(0, 160));

  const devId = addDevData && addDevData.developer && addDevData.developer._id;
  ok('the new developer has an id', !!devId, String(devId));

  console.log('\n── file a report with a screenshot, assigned to the developer ──');
  const createPage = await req('junior', '/admin/support');
  const csrfJunior = jsCsrfFrom(createPage.body);
  ok('the new developer appears in the assign list on the create form',
     createPage.body.includes('ZZ Dev One'), 'not found in page');

  // A tiny real PNG (1x1 pixel) so multer's disk write and the mail
  // attachment path both exercise a real file, not a stub.
  const PNG_1PX = Buffer.from(
    '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
    '1f15c4890000000a4944415478da6360000002000155a2415e0000000049454e44ae426082',
    'hex',
  );

  const fd = new FormData();
  fd.append('title', 'ZZFLOW2 broken button');
  fd.append('side', 'admin');
  fd.append('page', 'Support & Reports');
  fd.append('assignedDeveloper', devId);
  fd.append('severity', 'high');
  fd.append('description', 'Clicked the button.\nNothing happened.');
  fd.append('screenshots', new Blob([PNG_1PX], { type: 'image/png' }), 'proof.png');

  const posted = await req('junior', '/admin/support/report', {
    method: 'POST',
    headers: { 'X-CSRF-Token': csrfJunior },
    body: fd,
  });
  let postedData = null;
  try { postedData = JSON.parse(posted.body); } catch (e) {}
  ok('report created', postedData && postedData.success === true, posted.body.slice(0, 200));
  ok('email was sent', postedData && postedData.emailed === true, JSON.stringify(postedData));

  const reportId = postedData && postedData.reportId;
  const stored = reportId ? await BugReport.findById(reportId).lean() : null;
  ok('report stored with the developer snapshot',
     stored && stored.assignedDeveloperName === 'ZZ Dev One' && stored.assignedDeveloperEmail === 'zz-dev-one@example.com',
     JSON.stringify(stored && { name: stored.assignedDeveloperName, email: stored.assignedDeveloperEmail }));
  ok('the screenshot was actually written to disk',
     stored && stored.screenshots.length === 1
     && fs.existsSync(path.join(__dirname, 'public', 'uploads', stored.screenshots[0].filename)),
     stored && JSON.stringify(stored.screenshots));

  ok('exactly one email sent so far', SENT.length === 1, SENT.length);
  const firstMail = SENT[0];
  ok('addressed to the assigned developer', firstMail.to === 'zz-dev-one@example.com', firstMail.to);
  ok('the email carries the screenshot as an attachment',
     Array.isArray(firstMail.attachments) && firstMail.attachments.length === 1
     && firstMail.attachments[0].filename === 'proof.png',
     JSON.stringify(firstMail.attachments));
  ok('the attachment path points at a real file on disk',
     firstMail.attachments && fs.existsSync(firstMail.attachments[0].path),
     firstMail.attachments && firstMail.attachments[0].path);

  console.log('\n── a non-image upload is refused ──');
  const badFd = new FormData();
  badFd.append('title', 'ZZFLOW2 bad upload');
  badFd.append('side', 'client');
  badFd.append('page', 'x');
  badFd.append('assignedDeveloper', devId);
  badFd.append('description', 'x');
  badFd.append('screenshots', new Blob([Buffer.from('not an image')], { type: 'text/plain' }), 'notes.txt');

  const badPost = await req('junior', '/admin/support/report', {
    method: 'POST', headers: { 'X-CSRF-Token': csrfJunior }, body: badFd,
  });
  let badData = null;
  try { badData = JSON.parse(badPost.body); } catch (e) {}
  ok('a non-image attachment is rejected', badData && badData.success === false, JSON.stringify(badData));

  console.log('\n── remind resends to the assigned developer ──');
  const remind = await req('junior', '/admin/support/report/' + reportId + '/remind', {
    method: 'POST', headers: { 'X-CSRF-Token': csrfJunior },
  });
  let remindData = null;
  try { remindData = JSON.parse(remind.body); } catch (e) {}
  ok('reporter can remind about their own report', remindData && remindData.success === true, remind.body.slice(0, 160));
  ok('a second email was sent', SENT.length === 2, SENT.length);
  ok('the reminder also carries the attachment',
     SENT[1].attachments && SENT[1].attachments.length === 1, JSON.stringify(SENT[1].attachments));

  const afterRemind = await BugReport.findById(reportId).lean();
  ok('lastRemindedAt was stamped', !!afterRemind.lastRemindedAt, afterRemind.lastRemindedAt);

  console.log('\n── fixed/unfixed toggle, super admin only ──');
  const juniorFix = await req('junior', '/admin/support/report/' + reportId + '/update', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfJunior },
    body: JSON.stringify({ fixed: 'true' }),
  });
  ok('junior admin cannot mark a report fixed', juniorFix.status === 403, juniorFix.status);

  const superFix = await req('super', '/admin/support/report/' + reportId + '/update', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfSuper },
    body: JSON.stringify({ fixed: 'true', fixNote: 'Patched the handler.' }),
  });
  let superFixData = null;
  try { superFixData = JSON.parse(superFix.body); } catch (e) {}
  ok('super admin marks it fixed', superFixData && superFixData.success === true, superFix.body.slice(0, 160));

  const fixedRow = await BugReport.findById(reportId).lean();
  ok('fixed=true, fixedAt and fixedByName recorded',
     fixedRow.fixed === true && !!fixedRow.fixedAt && fixedRow.fixedByName === 'zzsupportsuper',
     JSON.stringify({ fixed: fixedRow.fixed, fixedAt: fixedRow.fixedAt, by: fixedRow.fixedByName }));
  ok('fix note recorded', fixedRow.fixNote === 'Patched the handler.', fixedRow.fixNote);

  const unfix = await req('super', '/admin/support/report/' + reportId + '/update', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfSuper },
    body: JSON.stringify({ fixed: 'false' }),
  });
  const unfixData = JSON.parse(unfix.body);
  ok('can be marked unfixed again', unfixData.success === true);
  const unfixedRow = await BugReport.findById(reportId).lean();
  ok('fixedAt cleared when unfixed', unfixedRow.fixed === false && unfixedRow.fixedAt === null,
     JSON.stringify({ fixed: unfixedRow.fixed, fixedAt: unfixedRow.fixedAt }));

  console.log('\n── report visibility scoping still holds ──');
  const juniorList = await req('junior', '/admin/support');
  ok('junior sees their own report', juniorList.body.includes('ZZFLOW2 broken button'));
  const superList = await req('super', '/admin/support');
  ok('super admin sees it too', superList.body.includes('ZZFLOW2 broken button'));

  console.log('\n── remove developer, super admin only, keeps history readable ──');
  const juniorRemove = await req('junior', '/admin/support/developers/' + devId + '/remove', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfJunior },
  });
  ok('junior admin cannot remove a developer', juniorRemove.status === 403, juniorRemove.status);

  const superRemove = await req('super', '/admin/support/developers/' + devId + '/remove', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfSuper },
  });
  const superRemoveData = JSON.parse(superRemove.body);
  ok('super admin removes the developer', superRemoveData.success === true, superRemove.body.slice(0, 160));

  const afterRemoval = await BugReport.findById(reportId).lean();
  ok('the report still shows the developer\'s name after removal',
     afterRemoval.assignedDeveloperName === 'ZZ Dev One', afterRemoval.assignedDeveloperName);

  const remindAfterRemoval = await req('junior', '/admin/support/report/' + reportId + '/remind', {
    method: 'POST', headers: { 'X-CSRF-Token': csrfJunior },
  });
  const remindAfterData = JSON.parse(remindAfterRemoval.body);
  ok('remind still works after the developer is removed (uses the snapshot email)',
     remindAfterData.success === true, remindAfterRemoval.body.slice(0, 160));

  const removedDev = await Developer.findById(devId).lean();
  ok('the developer no longer appears in future assign lists', !removedDev, JSON.stringify(removedDev));

  await BugReport.deleteMany({ title: /^ZZFLOW2/ });
  await Developer.deleteMany({ email: /zz-dev/ });
  await UserAdmin.deleteMany({ email: { $in: [SUPER_EMAIL, JUNIOR_EMAIL] } });
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.log('ERR ' + e.stack);
  try {
    await mongoose.connection.db.collection('useradmins').deleteMany({ email: { $in: [SUPER_EMAIL, JUNIOR_EMAIL] } });
    await mongoose.connection.db.collection('bugreports').deleteMany({ title: /^ZZFLOW2/ });
    await mongoose.connection.db.collection('developers').deleteMany({ email: /zz-dev/ });
  } catch (x) {}
  process.exit(1);
});
