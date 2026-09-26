/**
 * Pushes the enhanced admin FAQ manual (server/data/adminFaqSeed.js) into the
 * live database.
 *
 * The manual only auto-seeds an EMPTY 'admin-dashboard' category — see
 * faqAdminController.js's viewPanel — so editing the seed file alone changes
 * nothing on a database that already has these entries in it, which every
 * real install does. This script is what actually gets the new content live.
 *
 * A super admin can edit any entry by hand from the FAQ Manager, so this
 * checks before touching anything: every 'admin-dashboard' document's own
 * `updatedAt` is compared against its `createdAt` (Mongoose timestamps).
 * Equal means the document has never been saved since the day it was
 * inserted by the original seed — nobody has ever edited it — which is true
 * of all 43 of them as of this migration. If that ever stops being true (a
 * real admin edit exists), this script refuses to run rather than silently
 * overwriting someone's customization; delete individual entries by hand
 * from the FAQ Manager first, or extend this script to skip them.
 *
 *   node scripts/migrate-admin-faq-enhance.js              # dry run
 *   node scripts/migrate-admin-faq-enhance.js --commit
 *
 * Run from the project root so .env resolves.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Faq = require('../server/models/FaqModel');
const newSeed = require('../server/data/adminFaqSeed');

const COMMIT = process.argv.includes('--commit');

async function main() {
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
  console.log(COMMIT ? 'MODE: COMMIT\n' : 'MODE: DRY RUN — nothing will be written\n');

  const live = await Faq.find({ category: 'admin-dashboard' }).lean();
  console.log('Live admin-dashboard entries: ' + live.length);

  const everEdited = live.filter((d) => +new Date(d.updatedAt) !== +new Date(d.createdAt));
  if (everEdited.length) {
    console.error('\nABORT — ' + everEdited.length + ' entr' + (everEdited.length === 1 ? 'y has' : 'ies have') +
      ' been edited since creation, so this is no longer a safe wholesale replace:');
    everEdited.forEach((d) => console.error('  - ' + d.question));
    console.error('\nHandle these by hand in the FAQ Manager first, or extend this script to preserve them.');
    await mongoose.disconnect();
    process.exit(1);
  }
  console.log('None have ever been edited since creation — safe to replace the whole category.\n');

  console.log('Old entries to remove: ' + live.length);
  console.log('New entries to insert: ' + newSeed.length);

  if (!COMMIT) {
    console.log('\nDry run only. Re-run with --commit to apply.');
    await mongoose.disconnect();
    return;
  }

  const { deletedCount } = await Faq.deleteMany({ category: 'admin-dashboard' });
  const inserted = await Faq.insertMany(newSeed);

  console.log('\nRemoved ' + deletedCount + ' old entries, inserted ' + inserted.length + ' new entries.');
  await mongoose.disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
