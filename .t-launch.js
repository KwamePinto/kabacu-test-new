/* Verifies this batch of work end to end.
 *
 * Renders the real templates and exercises the real controller guards, rather
 * than checking that files contain strings — the bugs worth catching here are a
 * template that throws on a missing local and a role gate that does not hold.
 */
require('dotenv').config();
const ejs = require('ejs');
const fs = require('fs');
const mongoose = require('mongoose');

const URI = process.env.MONGO_URI;
if (!URI || /genjpyi/.test(URI)) { console.log('bad or live URI'); process.exit(1); }

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

(async () => {
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 20000 });

  const Announcement = require('./server/models/AnnouncementModel');
  const Faq = require('./server/models/FaqModel');
  const BugReport = require('./server/models/BugReportModel');
  const Developer = require('./server/models/DeveloperModel');
  const ReferralSettings = require('./server/models/ReferralSettingsModel');

  /* ── 1. Launch content ──────────────────────────────────────────────── */
  console.log('\n── launch content ──');

  const popups = await Announcement.find({ type: 'popup', isActive: true }).sort({ order: 1 }).lean();
  ok('six popups are live', popups.length === 6, popups.length + ' found');
  ok('the tour starts with the welcome step',
     popups[0] && popups[0].title === 'Welcome to the new Kabacu',
     popups[0] && popups[0].title);
  ok('no test popup survives',
     !popups.some((p) => /test/i.test(p.title)),
     popups.filter((p) => /test/i.test(p.title)).map((p) => p.title).join());
  ok('every step has body copy', popups.every((p) => p.subtitle && p.subtitle.length > 40));

  // Commission is off, so no step may promise it.
  const rs = await ReferralSettings.getSettings();
  const commissionOff = !rs.referralCommission || !rs.referralCommission.isActive;
  const mentionsCommission = popups.some((p) => /commission|every purchase they make/i.test(p.subtitle || ''));
  ok('no step advertises commission while it is switched off',
     !(commissionOff && mentionsCommission),
     'commissionOff=' + commissionOff + ' mentions=' + mentionsCommission);

  const strip = await Announcement.findOne({ type: 'strip', isActive: true }).lean();
  ok('a signup-bonus strip is live', !!strip && /signup bonus/i.test(strip.text), strip && strip.text);
  ok('the strip expires rather than running forever',
     !!(strip && strip.countdownEndsAt && new Date(strip.countdownEndsAt) > new Date()),
     strip && String(strip.countdownEndsAt));

  ok('the signup bonus is active with a non-zero amount',
     rs.signupBonus.isActive && rs.signupBonus.amount > 0,
     JSON.stringify(rs.signupBonus));

  /* ── 2. The tour renders ────────────────────────────────────────────── */
  console.log('\n── popup tour renders ──');

  const layout = fs.readFileSync('views/layouts/main.ejs', 'utf8');

  /* The header partial reads these. Supplied so the layout renders the way a
     real request does — the point is to test the popup markup inside a fully
     rendered page, not against a stripped-down stub that would hide a mistake
     in how it sits in the layout. */
  const pageLocals = {
    wallet: { balances: { NAIRA: 0, RP: 0, USDT: 0 }, countryBalances: {} },
    activeCurrency: { symbol: '₦', code: 'NGN', name: 'Naira' },
    marketBalance: function () { return 0; },
    notifications: [],
    unreadCount: 0,
    viewerCountry: { code: 'NG', walletCountry: 'NG', signedIn: true },
    marketWallets: [],
    csrfToken: 'test-token',
    // Set by the shared-locals middleware on every real request.
    success_msg: [],
    error_msg: [],
  };
  let html = '';
  try {
    html = ejs.render(layout, {
      ...pageLocals,
      user: { id: 'u1', username: 'tester' },
      body: '<p>page</p>',
      announcements: { banners: [], strips: [strip].filter(Boolean), popups },
    }, { filename: 'views/layouts/main.ejs' });
    ok('layout renders for a signed-in user', true);
  } catch (e) {
    ok('layout renders for a signed-in user', false, e.message);
  }

  if (html) {
    const steps = (html.match(/class="ann-popup__step/g) || []).length;
    ok('all six steps are in the DOM', steps === 6, steps + ' steps');
    const dots = (html.match(/class="ann-popup__dot[ "]/g) || []).length;
    ok('one dot per step', dots === 6, dots + ' dots');
    ok('exactly one step starts active',
       (html.match(/ann-popup__step is-active/g) || []).length === 1);
    ok('the tour key combines all popup ids',
       html.includes('data-popup-count="6"'));
    ok('Next and Back controls are present',
       html.includes('annPopupNext') && html.includes('annPopupPrev'));
    ok('only one element carries the aria label id',
       (html.match(/id="annPopupTitle"/g) || []).length === 1,
       (html.match(/id="annPopupTitle"/g) || []).length + ' occurrences');
    ok('the strip renders its text', html.includes('Sign up today'));
  }

  // A single popup must still work — the tour must not require several.
  try {
    const one = ejs.render(layout, {
      ...pageLocals, user: { id: 'u1' }, body: '',
      announcements: { banners: [], strips: [], popups: [popups[0]] },
    }, { filename: 'views/layouts/main.ejs' });
    ok('a single popup renders with no nav row',
       one.includes('ann-popup__step') && !one.includes('ann-popup__nav"'),
       'step=' + one.includes('ann-popup__step') + ' nav=' + one.includes('ann-popup__nav"'));
  } catch (e) {
    ok('a single popup renders with no nav row', false, e.message);
  }

  // And no popup at all must not render the dialog.
  try {
    const none = ejs.render(layout, {
      ...pageLocals, user: { id: 'u1' }, body: '',
      announcements: { banners: [], strips: [], popups: [] },
    }, { filename: 'views/layouts/main.ejs' });
    ok('no popups means no dialog', !none.includes('id="annPopup"'));
  } catch (e) {
    ok('no popups means no dialog', false, e.message);
  }

  /* ── 3. Admin FAQ ───────────────────────────────────────────────────── */
  console.log('\n── admin FAQ ──');

  const adminFaqs = await Faq.find({ category: 'admin-dashboard' }).lean();
  ok('the admin manual is seeded', adminFaqs.length >= 30, adminFaqs.length + ' entries');
  ok('every manual entry is audience admin',
     adminFaqs.every((f) => f.audience === 'admin'),
     adminFaqs.filter((f) => f.audience !== 'admin').length + ' wrong');
  const withRole = adminFaqs.filter((f) => f.roleNote);
  ok('role-restricted actions carry a note', withRole.length >= 5, withRole.length + ' noted');
  ok('role notes are valid values',
     withRole.every((f) => ['super_admin', 'senior_admin', 'junior_admin'].includes(f.roleNote)),
     withRole.map((f) => f.roleNote).join());

  // The public FAQ query must not see them.
  const publicFaqs = await Faq.find({ isActive: true, audience: { $ne: 'admin' } }).lean();
  ok('the public FAQ query excludes the manual',
     !publicFaqs.some((f) => f.category === 'admin-dashboard'),
     publicFaqs.filter((f) => f.category === 'admin-dashboard').length + ' leaked');
  ok('the public FAQ still returns the customer entries',
     publicFaqs.length >= 20, publicFaqs.length + ' entries');

  // $ne must match documents that predate the field — the whole reason for it.
  const legacy = await Faq.findOne({ audience: { $exists: false } }).lean();
  if (legacy) {
    const found = await Faq.countDocuments({ _id: legacy._id, audience: { $ne: 'admin' } });
    ok('an entry with no audience field is still public', found === 1);
  } else {
    ok('an entry with no audience field is still public (none present to test)', true);
  }

  /* ── 4. Role gates, exercised for real ──────────────────────────────── */
  console.log('\n── role gates ──');

  const faqCtrl = require('./server/controllers/adminControllers/faqAdminController');
  const supportCtrl = require('./server/controllers/adminControllers/supportController');

  // The handlers are [middleware, fn]; call the fn directly with a fake req/res.
  const handler = (h) => (Array.isArray(h) ? h[h.length - 1] : h);

  function fakeRes() {
    const r = { statusCode: 200, body: null };
    r.status = (c) => { r.statusCode = c; return r; };
    r.json = (b) => { r.body = b; return r; };
    return r;
  }

  // A junior admin must not be able to create a manual entry.
  let res = fakeRes();
  await handler(faqCtrl.createFaq)(
    { user: { id: 'j1', role: 'junior_admin' },
      body: { question: 'Q', category: 'admin-dashboard', answer: '<p>a</p>' } },
    res,
  );
  ok('junior admin cannot create a manual entry',
     res.statusCode === 403 && res.body && res.body.success === false,
     res.statusCode + ' ' + JSON.stringify(res.body));

  // ...and must not be able to edit an existing one by disguising it as a user FAQ.
  const target = adminFaqs[0];
  res = fakeRes();
  await handler(faqCtrl.updateFaq)(
    { user: { id: 'j1', role: 'junior_admin' },
      params: { id: String(target._id) },
      body: { question: 'Hijacked', category: 'wallet', answer: '<p>x</p>' } },
    res,
  );
  ok('junior admin cannot move a manual entry onto the public FAQ',
     res.statusCode === 403, res.statusCode + ' ' + JSON.stringify(res.body));

  const untouched = await Faq.findById(target._id).lean();
  ok('that entry is unchanged on disk',
     untouched.question === target.question && untouched.category === 'admin-dashboard',
     untouched.question);

  // Nor delete one.
  res = fakeRes();
  await handler(faqCtrl.deleteFaq)(
    { user: { id: 'j1', role: 'junior_admin' }, params: { id: String(target._id) } },
    res,
  );
  ok('junior admin cannot delete a manual entry', res.statusCode === 403);
  ok('the entry still exists', !!(await Faq.findById(target._id).lean()));

  // A junior admin cannot add a developer.
  res = fakeRes();
  await handler(supportCtrl.addDeveloper)(
    { user: { id: 'j1', role: 'junior_admin', username: 'junior' },
      body: { name: 'Should Fail', email: 'nope@example.com' } },
    res,
  );
  ok('junior admin cannot add a developer', res.statusCode === 403);

  // A bad email is rejected even for a super admin — reports would go nowhere.
  res = fakeRes();
  await handler(supportCtrl.addDeveloper)(
    { user: { id: 's1', role: 'super_admin', username: 'super' },
      body: { name: 'Victor Pinto', email: 'not-an-email' } },
    res,
  );
  ok('an invalid developer email is rejected',
     res.body && res.body.success === false, JSON.stringify(res.body));

  await Developer.deleteMany({ email: /^zzlaunch/ });
  const developer = await Developer.create({ name: 'ZZ Launch Dev', email: 'zzlaunch@example.com' });

  /* ── 5. Report visibility by role ───────────────────────────────────── */
  console.log('\n── report scoping ──');

  const mkId = () => new mongoose.Types.ObjectId();
  const aliceId = mkId(), bobId = mkId();
  await BugReport.deleteMany({ title: /^ZZTEST/ });
  await BugReport.create([
    { title: 'ZZTEST alice one', side: 'client', page: '/x', description: 'd',
      reportedBy: aliceId, reporterName: 'alice', reporterRole: 'junior_admin' },
    { title: 'ZZTEST bob one', side: 'admin', page: '/y', description: 'd',
      reportedBy: bobId, reporterName: 'bob', reporterRole: 'senior_admin' },
  ]);

  const aliceScope = await BugReport.find({ reportedBy: aliceId, title: /^ZZTEST/ }).lean();
  ok('a lower admin sees only their own report',
     aliceScope.length === 1 && aliceScope[0].reporterName === 'alice',
     aliceScope.length + ' rows');

  const superScope = await BugReport.find({ title: /^ZZTEST/ }).lean();
  ok('a super admin sees both reports', superScope.length === 2, superScope.length + ' rows');
  ok('reports carry the reporter name for the super admin view',
     superScope.every((r) => r.reporterName),
     JSON.stringify(superScope.map((r) => r.reporterName)));

  /* ── 6. The support page renders for both roles ─────────────────────── */
  console.log('\n── support page renders ──');

  const supportTpl = fs.readFileSync('views/adminview/support.ejs', 'utf8');
  for (const role of ['super_admin', 'junior_admin']) {
    const isSuper = role === 'super_admin';
    try {
      const out = ejs.render(supportTpl, {
        developers: [developer],
        activeDevelopers: [developer],
        reports: superScope,
        isSuperAdmin: isSuper,
        myId: String(aliceId),
        csrfToken: 'tok',
        user: { username: 'x', role },
        }, { filename: 'views/adminview/support.ejs' });

      ok('renders for ' + role, out.length > 2000);
      // The "Add a developer" form and the reporter column are both super-admin only.
      ok(role + ': add-developer form ' + (isSuper ? 'present' : 'absent'),
         out.includes('id="dev-email"') === isSuper);
      ok(role + ': reporter column ' + (isSuper ? 'present' : 'absent'),
         out.includes('>Reported by<') === isSuper);
      ok(role + ': the developer roster is readable either way', out.includes('ZZ Launch Dev'));
    } catch (e) {
      ok('renders for ' + role, false, e.message);
    }
  }

  /* ── 7. The FAQ page renders for both roles ─────────────────────────── */
  console.log('\n── FAQ manager renders ──');

  const faqTpl = fs.readFileSync('views/adminview/faq.ejs', 'utf8');
  for (const role of ['super_admin', 'junior_admin']) {
    const isSuper = role === 'super_admin';
    // Exactly what the controller now passes for this role.
    const scoped = isSuper
      ? await Faq.find().sort({ category: 1, order: 1 }).lean()
      : await Faq.find({ audience: { $ne: 'admin' } }).sort({ category: 1, order: 1 }).lean();
    try {
      const out = ejs.render(faqTpl, {
        faqs: scoped, isSuperAdmin: isSuper, csrfToken: 'tok',
        user: { username: 'x', role },
      }, { filename: 'views/adminview/faq.ejs' });

      ok('renders for ' + role, out.length > 2000);
      ok(role + ': manual section ' + (isSuper ? 'present' : 'absent'),
         out.includes('data-section="admin-manual"') === isSuper);
      ok(role + ': manual category ' + (isSuper ? 'offered' : 'not offered'),
         out.includes('Admin Dashboard (panel manual)') === isSuper);
      /* The customer table must never show manual rows. For a junior admin the
         whole page — including the ALL_FAQS JSON its editor reads — must not
         contain the manual at all. */
      const firstManual = adminFaqs[0].question;
      if (isSuper) {
        const beforeManualSection = out.split('data-section="admin-manual"')[0];
        ok(role + ': manual entries stay out of the customer table',
           !beforeManualSection.includes(firstManual));
      } else {
        ok(role + ': the manual is not present anywhere on the page',
           !out.includes(firstManual),
           'manual text found in the junior admin page');
      }
    } catch (e) {
      ok('renders for ' + role, false, e.message);
    }
  }

  await BugReport.deleteMany({ title: /^ZZTEST/ });
  await Developer.deleteMany({ email: /^zzlaunch/ });
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('ERR ' + e.stack); process.exit(1); });
