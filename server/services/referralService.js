const crypto = require('crypto');

const User             = require('../models/UserModel');
const Referral         = require('../models/ReferralModel');
const ReferralSettings = require('../models/ReferralSettingsModel');
const Wallet           = require('../models/WalletModal');
const Product          = require('../models/ProductsModal');

/* Unambiguous alphabet — no O/0, I/1, so codes survive being read aloud. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 8;

function randomCode() {
  const bytes = crypto.randomBytes(CODE_LEN);
  let out = '';
  for (let i = 0; i < CODE_LEN; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/**
 * Returns the user's referral code, generating and persisting one on first
 * access. Retries on the unique index in the rare event of a collision.
 */
async function ensureReferralCode(userId) {
  const user = await User.findById(userId).select('referralCode');
  if (!user) return null;
  if (user.referralCode) return user.referralCode;

  for (let attempt = 0; attempt < 6; attempt++) {
    const code = randomCode();
    try {
      await User.updateOne({ _id: userId }, { $set: { referralCode: code } });
      return code;
    } catch (err) {
      if (err && err.code === 11000) continue; // collided, try another
      throw err;
    }
  }
  throw new Error('Could not allocate a unique referral code');
}

/** Account creation time. See UserModel — there is no createdAt on old rows. */
function createdAtOf(userDoc) {
  return userDoc._id.getTimestamp();
}

/**
 * Validates and records a referral link.
 *
 * Rules, in the order a cheater would try to break them:
 *   1. the code must exist
 *   2. you cannot refer yourself
 *   3. you can only ever use one code (also enforced by a unique index)
 *   4. an older account cannot use a newer account's code
 *
 * Returns { success, message }.
 */
async function applyReferralCode(userId, rawCode) {
  const code = String(rawCode || '').trim().toUpperCase();
  if (!code) return { success: false, message: 'Enter a referral code.' };

  const settings = await ReferralSettings.getSettings();
  if (!settings.isActive) {
    return { success: false, message: 'The referral programme is currently closed.' };
  }

  const [referred, referrer] = await Promise.all([
    User.findById(userId),
    User.findOne({ referralCode: code }),
  ]);

  if (!referred) return { success: false, message: 'Account not found.' };
  if (!referrer) return { success: false, message: 'That referral code does not exist.' };

  // 2. self-referral
  if (String(referrer._id) === String(referred._id)) {
    return { success: false, message: 'You cannot use your own referral code.' };
  }

  // 3. one code per user, ever
  const existing = await Referral.findOne({ referred: referred._id });
  if (existing) {
    return { success: false, message: 'You have already used a referral code.' };
  }

  // 4. an older account cannot be referred by a newer one
  const referredAt = createdAtOf(referred);
  const referrerAt = createdAtOf(referrer);
  if (referrerAt.getTime() > referredAt.getTime()) {
    return {
      success: false,
      message: 'This code belongs to an account newer than yours, so it cannot be applied.',
    };
  }

  try {
    await Referral.create({
      referrer: referrer._id,
      referred: referred._id,
      codeUsed: code,
      status: 'pending',
    });
  } catch (err) {
    // Unique index on `referred` — lost a race against a concurrent request
    if (err && err.code === 11000) {
      return { success: false, message: 'You have already used a referral code.' };
    }
    throw err;
  }

  await User.updateOne({ _id: referred._id }, { $set: { referredBy: referrer._id } });

  return { success: true, message: `Referral code applied. ${referrer.username} will be rewarded after your first purchase.` };
}

/**
 * Credits the referrer. Assumes the referral is already `qualified`.
 * Returns a short description of what was granted, or null if nothing was.
 */
async function grantReward(referral, settings) {
  if (settings.rewardType === 'money') {
    if (!(settings.amount > 0)) return null;
    await Wallet.updateOne(
      { user: referral.referrer },
      { $inc: { 'balances.NAIRA': settings.amount } },
    );
    return { type: 'money', amount: settings.amount, note: `₦${settings.amount} credited to wallet` };
  }

  if (settings.rewardType === 'rewardpoint') {
    if (!(settings.amount > 0)) return null;
    await User.updateOne({ _id: referral.referrer }, { $inc: { rpBalance: settings.amount } });
    return { type: 'rewardpoint', amount: settings.amount, note: `${settings.amount} RP awarded` };
  }

  if (settings.rewardType === 'data') {
    if (!settings.dataProduct) return null;
    const product = await Product.findById(settings.dataProduct).lean();
    if (!product) return null;

    // Granting an actual bundle means sending it to a phone number, which the
    // referrer has to choose. Recording it as owed keeps the payout auditable
    // and lets it be fulfilled without silently doing nothing.
    const label = product.dataDetails
      ? `${product.dataDetails.plan_type} · ${product.dataDetails.network}`
      : 'data bundle';
    return {
      type: 'data',
      amount: 0,
      product: product._id,
      note: `Data reward owed: ${label}`,
    };
  }

  return null;
}

/**
 * Called after a user completes a purchase. If this was their first and they
 * were referred, the referrer is paid.
 *
 * Safe to call on every purchase: it no-ops unless there is a pending referral.
 */
async function handlePurchase(userId, { amount = 0, transactionId = null } = {}) {
  try {
    const referral = await Referral.findOne({ referred: userId, status: 'pending' });

    // Mark the first purchase regardless, so the flag is accurate for users
    // who were never referred.
    await User.updateOne(
      { _id: userId, hasMadeFirstPurchase: false },
      { $set: { hasMadeFirstPurchase: true } },
    );

    if (!referral) return;

    const settings = await ReferralSettings.getSettings();
    if (!settings.isActive) return;

    if (settings.minPurchaseAmount > 0 && amount < settings.minPurchaseAmount) {
      return; // stays pending — a later, larger purchase can still qualify
    }

    if (settings.maxRewardsPerReferrer > 0) {
      const paid = await Referral.countDocuments({
        referrer: referral.referrer,
        status: 'rewarded',
      });
      if (paid >= settings.maxRewardsPerReferrer) {
        referral.status = 'void';
        referral.rewardNote = 'Referrer reached their reward cap';
        await referral.save();
        return;
      }
    }

    referral.status = 'qualified';
    referral.qualifyingTransaction = transactionId;
    referral.qualifiedAt = new Date();
    await referral.save();

    const granted = await grantReward(referral, settings);
    if (!granted) {
      referral.rewardNote = 'Reward not configured — nothing granted';
      await referral.save();
      return;
    }

    referral.status        = 'rewarded';
    referral.rewardType    = granted.type;
    referral.rewardAmount  = granted.amount;
    referral.rewardProduct = granted.product || null;
    referral.rewardNote    = granted.note;
    referral.rewardedAt    = new Date();
    await referral.save();
  } catch (err) {
    // A referral payout must never break a purchase that already succeeded.
    console.error('[referralService handlePurchase]', err);
  }
}

module.exports = {
  ensureReferralCode,
  applyReferralCode,
  handlePurchase,
  randomCode,
};
