/**
 * Switches admin two-factor off for every admin account.
 *
 * The schema default is now false, which covers accounts that never had the
 * field set — Mongoose fills a missing path with the default when it loads the
 * document, so those admins are already exempt. Accounts with an explicit
 * `true` are not covered by a default change, and this clears those.
 *
 * Two-factor stays available per account from My Profile → Security; this only
 * changes the starting position.
 *
 *   node scripts/disable-admin-2fa.js          apply
 *   node scripts/disable-admin-2fa.js --dry    report only
 */
require('dotenv').config();
const mongoose = require('mongoose');

const DRY = process.argv.includes('--dry');
const URI = process.env.MONGO_URI;

if (!URI) { console.log('MONGO_URI is not set.'); process.exit(1); }
if (/genjpyi/.test(URI)) {
  console.log('REFUSING: MONGO_URI points at the live cluster.');
  process.exit(1);
}

(async () => {
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 30000 });
  const admins = mongoose.connection.db.collection('useradmins');
  console.log('  db: ' + mongoose.connection.name + (DRY ? '   (dry run)' : '') + '\n');

  const on = await admins.find({ twoFactorEnabled: true },
    { projection: { username: 1, email: 1, role: 1 } }).toArray();

  console.log('  admins with two-factor explicitly on: ' + on.length);
  on.forEach((a) => console.log('    ' + (a.username || '?') + '  <' + (a.email || '?') + '>  ' + a.role));

  const missing = await admins.countDocuments({ twoFactorEnabled: { $exists: false } });
  console.log('\n  admins with no setting at all: ' + missing
    + '  (already exempt — they inherit the new default of false)');

  if (!DRY && on.length) {
    /* Written explicitly rather than left to the default so the state is
       recorded in the data. An admin reading the collection later should be
       able to see that this is off on purpose, not merely unset. */
    const r = await admins.updateMany(
      { twoFactorEnabled: true },
      {
        $set: {
          twoFactorEnabled: false,
          twoFactorCodeHash: null,
          twoFactorExpires: null,
          twoFactorAttempts: 0,
        },
      },
    );
    console.log('\n  switched off: ' + r.modifiedCount);
  }

  const stillOn = await admins.countDocuments({ twoFactorEnabled: true });
  console.log('  admins still requiring a code: ' + stillOn);

  await mongoose.disconnect();
})().catch((e) => { console.log('ERR ' + e.stack); process.exit(1); });
