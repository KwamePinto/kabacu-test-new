/**
 * READ-ONLY conflict scan between the LIVE database (KabakuOld) and the TEST
 * database (KabakuNew), run before any merge. Writes nothing to either side.
 *
 * It answers four questions, in the order they matter:
 *
 *   1. Which collections exist on only one side? A collection present only in
 *      test is new-feature storage the live database has no equivalent of.
 *
 *   2. For collections on both sides, how do the _id sets overlap — and where
 *      the same _id exists on both, is the content actually the same? Same _id
 *      with different content is a real conflict: whichever way the merge runs,
 *      one version is lost.
 *
 *   3. Are there unique-index collisions? This is the one that silently breaks
 *      a merge: the same email (or code, or reference) on both sides under
 *      DIFFERENT _ids cannot coexist in one collection, so a copy either fails
 *      on a duplicate-key error or half-completes. Unique indexes are read from
 *      the databases themselves rather than assumed from the models.
 *
 *   4. For single-document config collections (sitesettings, referralsettings)
 *      — where a whole-document overwrite would silently discard either the
 *      live operational values or the new feature fields — a field-by-field
 *      diff, since those need merging per field, not per document.
 *
 *   node scripts/db-conflict-scan.js            # summary
 *   node scripts/db-conflict-scan.js --examples # include sample differing docs
 */
require('dotenv').config();
const fs = require('fs');
const { MongoClient } = require('mongodb');

const SHOW_EXAMPLES = process.argv.includes('--examples');
const OLD_ENV = 'C:/Users/user/Desktop/CTC/kabacu/KabakuOld/.env';

/* Churns constantly on a running site and carries no business data — noise in
   a conflict report, so it is counted but never diffed. */
const IGNORE = new Set(['sessions']);

/* Config singletons: one document that IS the settings, so they get a
   field-level diff instead of a document-level verdict. */
const SINGLETONS = new Set(['sitesettings', 'referralsettings']);

function readEnvFile(file, key) {
  const txt = fs.readFileSync(file, 'utf8');
  const m = new RegExp('^' + key + '\\s*=\\s*(.+)$', 'm').exec(txt);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
}

/* Stable stringification so two documents that differ only in key order, or
   only in how the driver hydrated an ObjectId/Date, do not read as different. */
function canon(v) {
  if (v === null || v === undefined) return String(v);
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v instanceof Date) return 'D' + v.getTime();
  if (v && v._bsontype === 'ObjectId') return 'O' + v.toString();
  if (v && v._bsontype) return 'B' + String(v);
  if (typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => k + ':' + canon(v[k])).join(',') + '}';
  }
  return typeof v + ':' + String(v);
}

function fieldsOf(doc) { return new Set(Object.keys(doc || {})); }

async function main() {
  const liveClient = new MongoClient(readEnvFile(OLD_ENV, 'MONGO_URI'), { serverSelectionTimeoutMS: 30000 });
  const testClient = new MongoClient(process.env.MONGO_URI, { serverSelectionTimeoutMS: 30000 });
  await liveClient.connect();
  await testClient.connect();
  const live = liveClient.db(), test = testClient.db();

  const liveCols = (await live.listCollections().toArray()).map((c) => c.name).filter((n) => !n.startsWith('system.'));
  const testCols = (await test.listCollections().toArray()).map((c) => c.name).filter((n) => !n.startsWith('system.'));
  const liveSet = new Set(liveCols), testSet = new Set(testCols);
  const all = [...new Set([...liveCols, ...testCols])].sort();

  // ── 1. Collection presence ─────────────────────────────────────────────
  console.log('======================================================================');
  console.log(' 1. COLLECTIONS');
  console.log('======================================================================');
  console.log('collection'.padEnd(30) + 'LIVE'.padStart(9) + 'TEST'.padStart(9) + '   status');
  console.log('-'.repeat(70));

  const shared = [], testOnly = [], liveOnly = [];
  for (const name of all) {
    const l = liveSet.has(name) ? await live.collection(name).countDocuments() : null;
    const t = testSet.has(name) ? await test.collection(name).countDocuments() : null;
    let status;
    if (l === null) { status = 'TEST ONLY — new feature storage'; testOnly.push({ name, count: t }); }
    else if (t === null) { status = 'LIVE ONLY'; liveOnly.push({ name, count: l }); }
    else { status = ''; shared.push(name); }
    console.log(name.padEnd(30) + String(l === null ? '—' : l).padStart(9) + String(t === null ? '—' : t).padStart(9) + '   ' + status);
  }

  // ── 2. Document overlap on shared collections ──────────────────────────
  console.log('\n======================================================================');
  console.log(' 2. DOCUMENT OVERLAP  (shared collections)');
  console.log('======================================================================');
  console.log('collection'.padEnd(26) + 'live-only'.padStart(10) + 'test-only'.padStart(10) +
              'both-same'.padStart(11) + 'both-DIFF'.padStart(11));
  console.log('-'.repeat(70));

  const conflicts = {};
  for (const name of shared) {
    if (IGNORE.has(name)) { console.log(name.padEnd(26) + '   (ephemeral — not compared)'); continue; }

    const liveDocs = new Map((await live.collection(name).find({}).toArray()).map((d) => [String(d._id), d]));
    const testDocs = new Map((await test.collection(name).find({}).toArray()).map((d) => [String(d._id), d]));

    let bothSame = 0; const bothDiff = [];
    for (const [id, ld] of liveDocs) {
      if (!testDocs.has(id)) continue;
      if (canon(ld) === canon(testDocs.get(id))) bothSame++;
      else bothDiff.push({ id, live: ld, test: testDocs.get(id) });
    }
    const liveOnlyCount = [...liveDocs.keys()].filter((id) => !testDocs.has(id)).length;
    const testOnlyCount = [...testDocs.keys()].filter((id) => !liveDocs.has(id)).length;

    conflicts[name] = { bothDiff, liveOnlyCount, testOnlyCount, bothSame };
    console.log(name.padEnd(26) + String(liveOnlyCount).padStart(10) + String(testOnlyCount).padStart(10) +
                String(bothSame).padStart(11) + String(bothDiff.length).padStart(11) +
                (bothDiff.length ? '   <-- CONFLICT' : ''));
  }

  // ── 3. Unique-index collisions ─────────────────────────────────────────
  console.log('\n======================================================================');
  console.log(' 3. UNIQUE-INDEX COLLISIONS  (same value, different _id — would break a copy)');
  console.log('======================================================================');

  let collisionTotal = 0;
  for (const name of shared) {
    if (IGNORE.has(name)) continue;
    const idx = await live.collection(name).indexes();
    const uniques = idx.filter((i) => i.unique && i.name !== '_id_');
    for (const u of uniques) {
      const keys = Object.keys(u.key);
      const proj = { _id: 1 }; keys.forEach((k) => { proj[k] = 1; });
      const valueOf = (d) => keys.map((k) => canon(d[k])).join('|');

      const liveDocs = await live.collection(name).find({}, { projection: proj }).toArray();
      const testDocs = await test.collection(name).find({}, { projection: proj }).toArray();

      const liveByVal = new Map();
      for (const d of liveDocs) {
        if (keys.some((k) => d[k] === undefined || d[k] === null)) continue; // sparse
        liveByVal.set(valueOf(d), String(d._id));
      }
      const collisions = [];
      for (const d of testDocs) {
        if (keys.some((k) => d[k] === undefined || d[k] === null)) continue;
        const v = valueOf(d);
        const liveId = liveByVal.get(v);
        if (liveId && liveId !== String(d._id)) {
          collisions.push({ value: keys.map((k) => d[k]).join('|'), liveId, testId: String(d._id) });
        }
      }
      if (collisions.length) {
        collisionTotal += collisions.length;
        console.log('\n  ' + name + '.' + keys.join('+') + '  (unique) — ' + collisions.length + ' collision(s)');
        collisions.slice(0, 8).forEach((c) =>
          console.log('     value=' + String(c.value).slice(0, 48) + '   live _id=' + c.liveId + '   test _id=' + c.testId));
        if (collisions.length > 8) console.log('     … and ' + (collisions.length - 8) + ' more');
      }
    }
  }
  if (collisionTotal === 0) console.log('  none — no unique value exists on both sides under different _ids.');

  // ── 4. Config singleton field diff ─────────────────────────────────────
  console.log('\n======================================================================');
  console.log(' 4. CONFIG SINGLETONS  (field-level — these need merging per field)');
  console.log('======================================================================');

  for (const name of SINGLETONS) {
    if (!liveSet.has(name) || !testSet.has(name)) continue;
    const l = await live.collection(name).findOne({});
    const t = await test.collection(name).findOne({});
    console.log('\n  --- ' + name + ' ---');
    if (!l || !t) { console.log('    missing on one side (live=' + !!l + ' test=' + !!t + ')'); continue; }
    console.log('    same _id on both sides: ' + (String(l._id) === String(t._id)));

    const keys = [...new Set([...fieldsOf(l), ...fieldsOf(t)])].sort();
    for (const k of keys) {
      if (k === '_id' || k === '__v' || k === 'updatedAt' || k === 'createdAt') continue;
      const inL = k in l, inT = k in t;
      const same = inL && inT && canon(l[k]) === canon(t[k]);
      if (same) continue;
      const show = (v) => { const s = typeof v === 'object' ? JSON.stringify(v) : String(v); return s.length > 60 ? s.slice(0, 57) + '…' : s; };
      if (!inL)      console.log('    + ' + k.padEnd(34) + 'TEST ONLY   test=' + show(t[k]));
      else if (!inT) console.log('    - ' + k.padEnd(34) + 'LIVE ONLY   live=' + show(l[k]));
      else           console.log('    ~ ' + k.padEnd(34) + 'DIFFERS     live=' + show(l[k]) + '   test=' + show(t[k]));
    }
  }

  // ── Examples of conflicting documents ──────────────────────────────────
  if (SHOW_EXAMPLES) {
    console.log('\n======================================================================');
    console.log(' 5. SAMPLE CONFLICTING DOCUMENTS (same _id, different content)');
    console.log('======================================================================');
    for (const [name, c] of Object.entries(conflicts)) {
      if (!c.bothDiff.length) continue;
      console.log('\n  --- ' + name + ' (' + c.bothDiff.length + ' conflicting) ---');
      for (const ex of c.bothDiff.slice(0, 3)) {
        const keys = [...new Set([...fieldsOf(ex.live), ...fieldsOf(ex.test)])].sort();
        const diffs = keys.filter((k) => k !== '__v' && canon(ex.live[k]) !== canon(ex.test[k]));
        console.log('    _id ' + ex.id + '  fields differing: ' + diffs.join(', ').slice(0, 140));
      }
    }
  }

  // ── Bottom line ────────────────────────────────────────────────────────
  console.log('\n======================================================================');
  console.log(' SUMMARY');
  console.log('======================================================================');
  console.log('  collections only in TEST (new feature storage): ' + testOnly.length +
    (testOnly.length ? '  [' + testOnly.map((c) => c.name + ':' + c.count).join(', ') + ']' : ''));
  console.log('  collections only in LIVE:                       ' + liveOnly.length +
    (liveOnly.length ? '  [' + liveOnly.map((c) => c.name + ':' + c.count).join(', ') + ']' : ''));
  const conflicting = Object.entries(conflicts).filter(([, c]) => c.bothDiff.length);
  console.log('  collections with same-_id content conflicts:    ' + conflicting.length +
    (conflicting.length ? '  [' + conflicting.map(([n, c]) => n + ':' + c.bothDiff.length).join(', ') + ']' : ''));
  console.log('  unique-index collisions:                        ' + collisionTotal);

  await liveClient.close();
  await testClient.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
