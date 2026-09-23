/**
 * Migrates the "upcoming maintenance" banner from a separate
 * maintenanceBannerScheduledAt Date field to free-text maintenanceBannerMessage
 * with an embedded {{countdown:...}} token — see SiteSettingsModel.js and
 * server/utils/maintenanceTokens.js. The banner is now written with the same
 * toolbar/"{}"-trigger editor as the maintenance page message.
 *
 * If a scheduled time was already set, it is carried forward into a
 * {{countdown:...}} token inside a generated message, so an already-configured
 * banner does not just go blank on deploy. Otherwise the schema's own default
 * placeholder text applies (nothing to do here).
 *
 *   node scripts/migrate-banner-message.js              # dry run
 *   node scripts/migrate-banner-message.js --commit
 *
 * Run from the project root so .env resolves. Safe to re-run: it only acts
 * when maintenanceBannerMessage is not already set.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const COMMIT = process.argv.includes('--commit');

function pad2(n) { return String(n).padStart(2, '0'); }

async function main() {
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI is not set. Run this from the project root.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
  const db = mongoose.connection.db;
  console.log(COMMIT ? 'MODE: COMMIT\n' : 'MODE: DRY RUN — nothing will be written\n');

  const raw = await db.collection('sitesettings').findOne({});
  if (!raw) {
    console.log('No settings document yet — nothing to migrate (a fresh one will get the schema default).');
    await mongoose.disconnect();
    return;
  }

  console.log('maintenanceBannerEnabled:', raw.maintenanceBannerEnabled);
  console.log('maintenanceBannerScheduledAt (old field):', raw.maintenanceBannerScheduledAt || '(not set)');
  console.log('maintenanceBannerMessage (new field):', raw.maintenanceBannerMessage || '(not set)');

  if (raw.maintenanceBannerMessage) {
    console.log('\nmaintenanceBannerMessage is already set — nothing to do.');
    await mongoose.disconnect();
    return;
  }

  let message;
  if (raw.maintenanceBannerScheduledAt) {
    const d = new Date(raw.maintenanceBannerScheduledAt);
    // Built from the UTC getters, NOT local ones — this script's own process
    // runs on whatever machine happens to invoke it (a laptop, a CI box, a
    // server), and that machine's timezone has nothing to do with the value
    // actually stored in Mongo. Local getters would silently re-encode the
    // stored instant using the migration-runner's own offset — reproduced
    // here and caught only by actually diffing the value against what
    // toISOString() already says (see the mismatch check below), not by
    // reasoning about it. UTC getters reproduce the exact digits already in
    // the database, unconditionally, no matter where this runs.
    const value = d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()) +
      'T' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes());
    if (value !== d.toISOString().slice(0, 16)) {
      throw new Error('UTC reconstruction does not match the source ISO string — refusing to guess: ' + value + ' vs ' + d.toISOString());
    }
    message = 'Kabacu will undergo scheduled maintenance on {{countdown:' + value + '}}. Please save your work before then.';
    console.log('\nCarrying the existing scheduled time forward as a countdown token: ' + value);
  } else {
    message = 'Kabacu will undergo scheduled maintenance on [DATE] at [TIME]. Please save your work before then.';
    console.log('\nNo scheduled time was set — seeding the default placeholder text.');
  }

  console.log('New maintenanceBannerMessage: ' + JSON.stringify(message));

  if (!COMMIT) {
    console.log('\nDry run only. Re-run with --commit to apply.');
    await mongoose.disconnect();
    return;
  }

  await db.collection('sitesettings').updateOne(
    { _id: raw._id },
    { $set: { maintenanceBannerMessage: message }, $unset: { maintenanceBannerScheduledAt: '' } },
  );

  try {
    require('../server/middleware/maintenanceMiddleware').invalidateCache();
  } catch (_) { /* fine if this process never warmed the cache */ }

  console.log('\nSaved.');
  await mongoose.disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
