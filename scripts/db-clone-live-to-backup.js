/**
 * Clones the LIVE production database (KabakuOld's MONGO_URI) into the
 * standalone backup cluster (MONGO_URI_BACKUP_DIRECT), documents and indexes.
 *
 *   node scripts/db-clone-live-to-backup.js            # dry run
 *   node scripts/db-clone-live-to-backup.js --commit
 *
 * This is the safety net taken before the old→new database merge, so it is
 * deliberately one-directional and paranoid:
 *
 *   • LIVE is opened read-only in intent and never written to — the only
 *     writes in this file target the backup client.
 *   • It refuses to run against a backup database that already holds data,
 *     unless --force is passed, so a second accidental run cannot double up
 *     documents or half-overwrite an existing good backup.
 *   • Every collection's count is re-read from both sides afterwards and
 *     compared; a mismatch is reported loudly and sets a non-zero exit code,
 *     because "the backup finished" and "the backup is complete" are not the
 *     same claim.
 *
 * _id values are preserved exactly, so this backup can be restored straight
 * back over the live database if the merge has to be undone.
 */
require('dotenv').config();
const fs = require('fs');
const { MongoClient } = require('mongodb');

const COMMIT = process.argv.includes('--commit');
const FORCE = process.argv.includes('--force');
const BATCH = 1000;

const OLD_ENV = 'C:/Users/user/Desktop/CTC/kabacu/KabakuOld/.env';

function readEnvFile(file, key) {
  const txt = fs.readFileSync(file, 'utf8');
  const m = new RegExp('^' + key + '\\s*=\\s*(.+)$', 'm').exec(txt);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
}

function hostOf(uri) {
  const m = uri.replace(/\/\/[^@]*@/, '//').match(/@?([^/@?]+)/);
  return (uri.replace(/\/\/[^@]*@/, '//<creds>@').match(/@([^/?,]+)/) || [])[1] || '?';
}

async function main() {
  const liveUri = readEnvFile(OLD_ENV, 'MONGO_URI');
  const backupUri = process.env.MONGO_URI_BACKUP_DIRECT;

  if (!liveUri)   { console.error('LIVE MONGO_URI not found in ' + OLD_ENV); process.exit(1); }
  if (!backupUri) { console.error('MONGO_URI_BACKUP_DIRECT not set in this project .env'); process.exit(1); }

  console.log(COMMIT ? 'MODE: COMMIT — the backup will be written\n' : 'MODE: DRY RUN — nothing will be written\n');
  console.log('  SOURCE (live):  ' + hostOf(liveUri));
  console.log('  TARGET (backup):' + hostOf(backupUri));

  const liveClient = new MongoClient(liveUri, { serverSelectionTimeoutMS: 30000 });
  const backupClient = new MongoClient(backupUri, { serverSelectionTimeoutMS: 30000 });
  await liveClient.connect();
  await backupClient.connect();

  const live = liveClient.db();
  const backup = backupClient.db();
  console.log('  source db: ' + live.databaseName + '   target db: ' + backup.databaseName + '\n');

  const names = (await live.listCollections().toArray())
    .map((c) => c.name).filter((n) => !n.startsWith('system.')).sort();

  // ── Guard: never write over an existing backup by accident ──────────────
  const existing = (await backup.listCollections().toArray()).filter((c) => !c.name.startsWith('system.'));
  let existingDocs = 0;
  for (const c of existing) existingDocs += await backup.collection(c.name).countDocuments();
  if (existingDocs > 0 && !FORCE) {
    console.error('ABORT — the backup database already holds ' + existingDocs +
      ' document(s) across ' + existing.length + ' collection(s).');
    console.error('Re-run with --force to drop and replace it, but be sure that backup is not the only copy of something.');
    await liveClient.close(); await backupClient.close();
    process.exit(1);
  }

  const plan = [];
  let total = 0;
  for (const name of names) {
    const count = await live.collection(name).countDocuments();
    const idx = await live.collection(name).indexes();
    plan.push({ name, count, indexes: idx.filter((i) => i.name !== '_id_') });
    total += count;
  }

  console.log('Collections to clone: ' + plan.length + ',  documents: ' + total);
  plan.forEach((p) => console.log('  ' + p.name.padEnd(32) + String(p.count).padStart(7) +
    '  (+' + p.indexes.length + ' index' + (p.indexes.length === 1 ? '' : 'es') + ')'));

  if (!COMMIT) {
    console.log('\nDry run only. Re-run with --commit to write the backup.');
    await liveClient.close(); await backupClient.close();
    return;
  }

  // ── Copy ────────────────────────────────────────────────────────────────
  console.log('\nCloning…');
  for (const { name, count, indexes } of plan) {
    if (FORCE) await backup.collection(name).drop().catch(() => {});

    let copied = 0;
    if (count > 0) {
      const cursor = live.collection(name).find({}, { noCursorTimeout: false });
      let batch = [];
      for await (const doc of cursor) {
        batch.push(doc);
        if (batch.length >= BATCH) {
          await backup.collection(name).insertMany(batch, { ordered: false });
          copied += batch.length;
          batch = [];
        }
      }
      if (batch.length) {
        await backup.collection(name).insertMany(batch, { ordered: false });
        copied += batch.length;
      }
    } else {
      // Keep empty collections so the backup mirrors the source exactly.
      await backup.createCollection(name).catch(() => {});
    }

    for (const idx of indexes) {
      const { key, name: idxName, v, ns, background, ...opts } = idx;
      await backup.collection(name).createIndex(key, { name: idxName, ...opts }).catch((e) => {
        console.log('    ! index ' + idxName + ' on ' + name + ': ' + e.message);
      });
    }
    console.log('  ' + name.padEnd(32) + String(copied).padStart(7) + ' copied');
  }

  // ── Verify ──────────────────────────────────────────────────────────────
  console.log('\nVerifying…');
  let mismatches = 0, verifiedDocs = 0;
  for (const { name } of plan) {
    const a = await live.collection(name).countDocuments();
    const b = await backup.collection(name).countDocuments();
    verifiedDocs += b;
    if (a !== b) { console.log('  MISMATCH ' + name + ': live=' + a + ' backup=' + b); mismatches++; }
  }

  if (mismatches) {
    console.log('\n' + mismatches + ' collection(s) DO NOT MATCH — the backup is not trustworthy. Do not proceed to the merge.');
    process.exitCode = 1;
  } else {
    console.log('  all ' + plan.length + ' collections match exactly (' + verifiedDocs + ' documents).');
    console.log('\nBackup complete and verified.');
  }

  await liveClient.close();
  await backupClient.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
