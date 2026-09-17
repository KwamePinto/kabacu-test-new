require('dotenv').config();
const mongoose = require('mongoose');
const UserModel = require('../server/models/userModel');
const UserAdminModel = require('../server/models/UserAdminModel.js')

const TARGET_EMAIL = 'nanvanggodfrey.ctc@gmail.com';

async function run() {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('DB connected');

    const user = await UserAdminModel.findOne({ email: TARGET_EMAIL });
    if (!user) {
        console.error(`No Admin account found with email: ${TARGET_EMAIL}`);
        process.exit(1);
    }

    console.log(`Found: ${user.username} (${user.role}) — _id: ${user._id}`);

    /* const userId = user._id;
 
     // ── 1. Resolve related models lazily so a missing file doesn't break the script
     const safeRequire = (path) => {
         try { return require(path); }
         catch (e) { console.warn(`  ⚠ Could not load ${path} — skipping that collection`); return null; }
     };
 
     const WalletModel = safeRequire('../server/models/WalletModel');
     const CartModel = safeRequire('../server/models/CartModel');
     const CheckoutModel = safeRequire('../server/models/CheckoutModel');
     const TopUpModel = safeRequire('../server/models/TopUpModel');
     const ReferralModel = safeRequire('../server/models/ReferralModel');
     // Add any other models that reference this user below…
 
     const results = {};
 
     const del = async (label, fn) => {
         try {
             const r = await fn();
             results[label] = r?.deletedCount ?? r?.modifiedCount ?? 0;
             console.log(`  ✓ ${label}: ${results[label]}`);
         } catch (e) {
             console.error(`  ✗ ${label} failed: ${e.message}`);
         }
     };
 
     // ── 2. Cascade deletes on documents owned by this user (direct ObjectId refs)
 
     if (WalletModel) {
         await del('Wallet', () => WalletModel.deleteMany({ user: userId }));
     }
 
     if (CartModel) {
         await del('Cart', () => CartModel.deleteMany({ user: userId }));
     }
 
     if (CheckoutModel) {
         await del('Checkout', () => CheckoutModel.deleteMany({ user: userId }));
     }
 
     if (TopUpModel) {
         await del('TopUp', () => TopUpModel.deleteMany({ user: userId }));
     }
 
     // ── 3. Referrals: this user may be the referrer OR the referred party
 
     if (ReferralModel) {
         // Only delete referrals where this user is the *referred* party.
         // If they are the referrer, we may want to null out the link instead of
         // deleting historic reward records — but that's a business call.
         await del('Referral (as referred)', () =>
             ReferralModel.deleteMany({ referredUser: userId })
         );
 
         // Null out any referral records where this user is the referrer so the
         // reward history is preserved but no dangling refs remain.
         await del('Referral (as referrer, unlinked)', () =>
             ReferralModel.updateMany(
                 { referrer: userId },
                 { $set: { referrer: null } }
             )
         );
     }
 
     // ── 4. Users this person referred: clear their `referredBy` link
     await del('Referrals from other users (unlinked)', () =>
         UserModel.updateMany(
             { referredBy: userId },
             { $set: { referredBy: null } }
         )
     );
 
     // ── 5. Finally, delete the user document itself
     await del('User', () => UserModel.deleteOne({ _id: userId }));
 
     console.log('\nDone. Summary:');
     console.table(results);
 
     await mongoose.disconnect();
     process.exit(0);
     */
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});

