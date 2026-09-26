/**
 * Merges the new-feature data from the TEST database into the LIVE database,
 * ahead of pointing KabakuNew at live.
 *
 *   node scripts/db-merge-into-live.js                  # dry run
 *   node scripts/db-merge-into-live.js --commit
 *   node scripts/db-merge-into-live.js --commit --no-maintenance
 *
 * LIVE is the base and the only database written to. TEST is read-only here,
 * and its users / transactions / topups / wallets / checkouts / products /
 * networks / referral activity are deliberately NOT imported: test is a fork
 * of live taken months ago and has since diverged, so its copies of that data
 * are stale. Live keeps its own.
 *
 * What does come across is only what the new features need in order to work at
 * all, none of which live has any version of:
 *
 *   countrywallets (NG)   the new multi-country wallet code needs a market to
 *                         exist; live has zero, so without this there is no
 *                         currency for anything to be priced in
 *   supportsettings       developer contact for the support panel
 *   developers            the assignable list behind bug reports
 *   gsubzplans            GSubz provider plans (the one flagged deleted in test
 *                         is skipped — it is a leftover test row)
 *   faqs/admin-dashboard  the 48-entry admin manual; live has none
 *   specialreferralcodes  the reserved vanity-code pool, all unassigned
 *   useradmins x2         two admins that only ever existed in test
 *
 * Plus one field-level patch: live's paymentmethods predate the multi-country
 * work and lack country/kind/provider/instructions, which the new payment code
 * reads. Only fields that are ABSENT on live are filled in — an existing value
 * is never overwritten, so live's own configuration always wins.
 *
 * Every step is additive. Nothing that live already has is modified or removed,
 * with the single deliberate exception of maintenance mode being switched on at
 * the end (see --no-maintenance), so customers do not reach untested products
 * between the merge and the cutover.
 */
require('dotenv').config();
const fs = require('fs');
const { MongoClient } = require('mongodb');

const COMMIT = process.argv.includes('--commit');
const NO_MAINTENANCE = process.argv.includes('--no-maintenance');
const OLD_ENV = 'C:/Users/user/Desktop/CTC/kabacu/KabakuOld/.env';

function readEnvFile(file, key) {
  const txt = fs.readFileSync(file, 'utf8');
  const m = new RegExp('^' + key + '\\s*=\\s*(.+)$', 'm').exec(txt);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
}

/* Admins that exist only in test, imported with the status they already have
   there — one is intentionally inactive. */
const IMPORT_ADMIN_EMAILS = ['ecklujohn@gmail.com', 'roseteye.ctc@gmail.com'];

const log = [];
function step(name, detail) { log.push({ name, detail }); console.log('  ' + name.padEnd(46) + detail); }

async function main() {
  const liveClient = new MongoClient(readEnvFile(OLD_ENV, 'MONGO_URI'), { serverSelectionTimeoutMS: 30000 });
  const testClient = new MongoClient(process.env.MONGO_URI, { serverSelectionTimeoutMS: 30000 });
  await liveClient.connect(); await testClient.connect();
  const live = liveClient.db(), test = testClient.db();

  console.log(COMMIT ? 'MODE: COMMIT — LIVE WILL BE WRITTEN TO\n' : 'MODE: DRY RUN — nothing will be written\n');
  console.log('  target (live): ' + live.databaseName + ' @ ' + (readEnvFile(OLD_ENV, 'MONGO_URI').match(/@([^:,]+)/) || [])[1]);
  console.log('  source (test): ' + test.databaseName + '  [read-only]\n');

  /* Every insert is guarded on the live collection being empty. If a rerun
     finds rows already there, the step is skipped rather than duplicated —
     these collections all start empty on live, so anything present means this
     already ran. */
  async function importCollection(name, filter, label) {
    const existing = await live.collection(name).countDocuments();
    const docs = await test.collection(name).find(filter || {}).toArray();
    if (existing > 0) { step(label || name, 'SKIP — live already has ' + existing + ' doc(s)'); return 0; }
    step(label || name, (COMMIT ? 'insert ' : 'would insert ') + docs.length + ' doc(s)');
    if (COMMIT && docs.length) await live.collection(name).insertMany(docs, { ordered: false });
    return docs.length;
  }

  console.log('── 1. New-feature collections ' + '─'.repeat(30));
  await importCollection('countrywallets', { country: 'NG' }, 'countrywallets (NG only)');
  await importCollection('supportsettings', {}, 'supportsettings');
  await importCollection('developers', {}, 'developers');
  await importCollection('gsubzplans', { is_deleted: { $ne: 1 } }, 'gsubzplans (active only)');
  await importCollection('specialreferralcodes', {}, 'specialreferralcodes (reserved pool)');

  console.log('\n── 2. Admin FAQ manual ' + '─'.repeat(37));
  {
    const existing = await live.collection('faqs').countDocuments({ category: 'admin-dashboard' });
    const docs = await test.collection('faqs').find({ category: 'admin-dashboard' }).toArray();
    if (existing > 0) step('faqs (admin-dashboard)', 'SKIP — live already has ' + existing);
    else {
      step('faqs (admin-dashboard)', (COMMIT ? 'insert ' : 'would insert ') + docs.length + ' entries');
      if (COMMIT && docs.length) await live.collection('faqs').insertMany(docs, { ordered: false });
    }
  }

  console.log('\n── 3. Test-only admin accounts ' + '─'.repeat(29));
  for (const email of IMPORT_ADMIN_EMAILS) {
    const already = await live.collection('useradmins').findOne({ email });
    const src = await test.collection('useradmins').findOne({ email });
    if (!src) { step(email, 'NOT FOUND in test — skipped'); continue; }
    if (already) { step(email, 'SKIP — already on live'); continue; }
    step(email, (COMMIT ? 'insert ' : 'would insert ') + '(' + src.role + ', active=' + src.isActive + ')');
    if (COMMIT) await live.collection('useradmins').insertOne(src);
  }

  console.log('\n── 4. paymentmethods — fill in only ABSENT fields ' + '─'.repeat(11));
  {
    const NEW_FIELDS = ['country', 'kind', 'provider', 'instructions'];
    for (const ld of await live.collection('paymentmethods').find({}).toArray()) {
      const td = await test.collection('paymentmethods').findOne({ _id: ld._id });
      const patch = {};
      for (const f of NEW_FIELDS) {
        if (ld[f] !== undefined) continue;                       // live already has it — never overwrite
        if (td && td[f] !== undefined) patch[f] = td[f];
        else if (f === 'country') patch[f] = 'NG';               // fallback market
      }
      if (!Object.keys(patch).length) { step(String(ld.name || ld._id), 'nothing missing'); continue; }
      step(String(ld.name || ld._id), (COMMIT ? 'set ' : 'would set ') + JSON.stringify(patch).slice(0, 90));
      if (COMMIT) await live.collection('paymentmethods').updateOne({ _id: ld._id }, { $set: patch });
    }
  }

  console.log('\n── 5. Maintenance mode ' + '─'.repeat(37));
  if (NO_MAINTENANCE) {
    step('maintenanceModeEnabled', 'LEFT ALONE (--no-maintenance)');
  } else {
    const s = await live.collection('sitesettings').findOne({});
    if (!s) step('maintenanceModeEnabled', 'no sitesettings doc on live — SKIPPED');
    else {
      step('maintenanceModeEnabled', 'currently ' + s.maintenanceModeEnabled + (COMMIT ? ' -> set true' : ' -> would set true'));
      if (COMMIT) await live.collection('sitesettings').updateOne({ _id: s._id }, { $set: { maintenanceModeEnabled: true } });
    }
  }

  // ── Verify ──────────────────────────────────────────────────────────────
  if (COMMIT) {
    console.log('\n── Verification ' + '─'.repeat(44));
    const checks = [
      ['countrywallets', {}, 1],
      ['supportsettings', {}, 1],
      ['developers', {}, 1],
      ['gsubzplans', {}, 6],
      ['specialreferralcodes', {}, 422],
      ['faqs', { category: 'admin-dashboard' }, 48],
      ['useradmins', {}, 10],
    ];
    let bad = 0;
    for (const [coll, filter, expected] of checks) {
      const n = await live.collection(coll).countDocuments(filter);
      const ok = n === expected;
      if (!ok) bad++;
      console.log('  ' + (ok ? 'ok  ' : 'BAD ') + coll.padEnd(28) + n + ' (expected ' + expected + ')');
    }
    const s = await live.collection('sitesettings').findOne({});
    console.log('  ' + (NO_MAINTENANCE || s.maintenanceModeEnabled ? 'ok  ' : 'BAD ') +
      'maintenanceModeEnabled'.padEnd(28) + s.maintenanceModeEnabled);

    // Live's own data must be untouched.
    for (const [coll, expected] of [['users', 7191], ['transactions', 7205], ['topups', 7312], ['wallets', 1045], ['products', 35]]) {
      const n = await live.collection(coll).countDocuments();
      const ok = n === expected;
      if (!ok) bad++;
      console.log('  ' + (ok ? 'ok  ' : 'BAD ') + ('live ' + coll + ' untouched').padEnd(28) + n + ' (expected ' + expected + ')');
    }
    console.log('\n' + (bad ? bad + ' CHECK(S) FAILED' : 'All checks passed.'));
    process.exitCode = bad ? 1 : 0;
  } else {
    console.log('\nDry run only. Re-run with --commit to apply.');
  }

  await liveClient.close(); await testClient.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
