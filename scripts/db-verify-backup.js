/**
 * Verifies the backup clone against LIVE — beyond just counting.
 *
 * Counts alone can hide problems (the same number of wrong documents still
 * counts the same), so for the collections that actually carry business data
 * this compares the full set of _id values on both sides and reports anything
 * present in live but missing from the backup.
 *
 * `sessions` is checked but reported separately: it is the express-session
 * store on a site that is still serving traffic, so it gains and loses rows
 * continuously while a clone runs. Drift there says nothing about backup
 * integrity — those rows are ephemeral login state with a TTL, carrying no
 * user, money, or order data.
 *
 *   node scripts/db-verify-backup.js
 */
require('dotenv').config();
const fs = require('fs');
const { MongoClient } = require('mongodb');

const OLD_ENV = 'C:/Users/user/Desktop/CTC/kabacu/KabakuOld/.env';
const EPHEMERAL = new Set(['sessions']);

/* The collections whose loss would actually cost something. Verified by _id,
   not just by count. */
const CRITICAL = ['users', 'transactions', 'topups', 'wallets', 'checkouts',
                  'beneficiaries', 'conversions', 'coursepurchases', 'useradmins',
                  'products', 'referralcodes', 'testers'];

function readEnvFile(file, key) {
  const txt = fs.readFileSync(file, 'utf8');
  const m = new RegExp('^' + key + '\\s*=\\s*(.+)$', 'm').exec(txt);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
}

async function main() {
  const liveClient = new MongoClient(readEnvFile(OLD_ENV, 'MONGO_URI'), { serverSelectionTimeoutMS: 30000 });
  const backupClient = new MongoClient(process.env.MONGO_URI_BACKUP_DIRECT, { serverSelectionTimeoutMS: 30000 });
  await liveClient.connect();
  await backupClient.connect();
  const live = liveClient.db(), backup = backupClient.db();

  const names = (await live.listCollections().toArray())
    .map((c) => c.name).filter((n) => !n.startsWith('system.')).sort();

  console.log('=== Count comparison ===');
  const drifted = [], mismatched = [];
  for (const name of names) {
    const a = await live.collection(name).countDocuments();
    const b = await backup.collection(name).countDocuments();
    if (a === b) continue;
    (EPHEMERAL.has(name) ? drifted : mismatched).push({ name, live: a, backup: b });
  }

  if (!mismatched.length) {
    console.log('  every non-ephemeral collection matches exactly.');
  } else {
    mismatched.forEach((m) => console.log('  MISMATCH ' + m.name + ': live=' + m.live + ' backup=' + m.backup));
  }
  drifted.forEach((d) => console.log('  (ephemeral) ' + d.name + ': live=' + d.live + ' backup=' + d.backup +
    '  drift=' + (d.live - d.backup) + ' — expected on a running site'));

  console.log('\n=== _id set comparison on business-critical collections ===');
  let missingTotal = 0;
  for (const name of CRITICAL) {
    if (!names.includes(name)) { console.log('  ' + name.padEnd(20) + 'not present in live — skipped'); continue; }
    const liveIds = new Set((await live.collection(name).find({}, { projection: { _id: 1 } }).toArray()).map((d) => String(d._id)));
    const backupIds = new Set((await backup.collection(name).find({}, { projection: { _id: 1 } }).toArray()).map((d) => String(d._id)));
    const missing = [...liveIds].filter((id) => !backupIds.has(id));
    const extra = [...backupIds].filter((id) => !liveIds.has(id));
    missingTotal += missing.length;
    const verdict = missing.length === 0
      ? 'all ' + liveIds.size + ' _ids present' + (extra.length ? '  (+' + extra.length + ' extra in backup)' : '')
      : missing.length + ' MISSING from backup';
    console.log('  ' + name.padEnd(20) + verdict);
  }

  console.log('\n' + (mismatched.length === 0 && missingTotal === 0
    ? 'BACKUP VERIFIED — every business record in live exists in the backup.'
    : 'BACKUP INCOMPLETE — do not proceed to the merge.'));

  await liveClient.close();
  await backupClient.close();
  process.exitCode = (mismatched.length === 0 && missingTotal === 0) ? 0 : 1;
}

main().catch((err) => { console.error(err); process.exit(1); });
