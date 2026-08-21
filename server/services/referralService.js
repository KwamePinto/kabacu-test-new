const crypto = require('crypto');

const User             = require('../models/UserModel');
const Referral         = require('../models/ReferralModel');
const ReferralSettings = require('../models/ReferralSettingsModel');
const Wallet           = require('../models/WalletModal');
const Product          = require('../models/ProductsModal');
const SpecialCode      = require('../models/SpecialReferralCodeModel');

/**
 * System-generated codes are always KB + 8 digits, 10 characters in total:
 *   KB48120375
 *
 * Digits only after the prefix, so a code can be read aloud or typed on a
 * numeric keypad without letter/number confusion. Admin-created special codes
 * are exempt from this shape entirely — see SpecialReferralCodeModel.
 */
const CODE_PREFIX = 'KB';
const CODE_DIGITS = 8;
const CODE_LEN    = CODE_PREFIX.length + CODE_DIGITS; // 10

/** True for anything matching the system's own KB######## shape. */
function isSystemCode(code) {
  return new RegExp(`^${CODE_PREFIX}\\d{${CODE_DIGITS}}$`).test(String(code || '').toUpperCase());
}

function randomCode() {
  // crypto.randomInt avoids the modulo bias a randomBytes%10 would introduce
  let digits = '';
  for (let i = 0; i < CODE_DIGITS; i++) digits += crypto.randomInt(0, 10);
  return CODE_PREFIX + digits;
}

/**
 * Returns the user's referral code, generating and persisting one on first
 * access. Retries on the unique index in the rare event of a collision.
 */
async function ensureReferralCode(userId) {
  const user = await User.findById(userId).select('referralCode');
  if (!user) return null;
  if (user.referralCode) return user.referralCode;

  for (let attempt = 0; attempt < 8; attempt++) {
    const code = randomCode();

    // Never hand out a code being held back for sale, even if an admin has
    // reserved something that happens to match the KB######## shape.
    if (await SpecialCode.exists({ code })) continue;

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

  // Deliberately no format check. Admin-created special codes can be any
  // characters and any length, so the only question that matters is whether
  // the code actually belongs to somebody.
  const [referred, referrer] = await Promise.all([
    User.findById(userId),
    User.findOne({ referralCode: code }),
  ]);

  if (!referred) return { success: false, message: 'Account not found.' };

  if (!referrer) {
    // Distinguish "reserved for sale, not yet issued" from "no such code", so
    // support can tell a mistyped code from a premium one that hasn't been
    // handed out. Either way it cannot be used.
    const reserved = await SpecialCode.findOne({ code }).lean();
    if (reserved) {
      return { success: false, message: 'That code is reserved and has not been issued yet.' };
    }
    return { success: false, message: 'That referral code does not exist.' };
  }

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

/**
 * Pays the signup-bonus promotion, if it is switched on.
 *
 * Called at EMAIL VERIFICATION, not at signup — creating an account is free and
 * unlimited, so paying before a working inbox is proven makes the promotion
 * trivially farmable. Applies to every verified user, referred or not.
 *
 * Idempotent: the paid-at stamp is claimed with a conditional update, so a
 * retried or replayed verification cannot pay twice.
 */
async function grantSignupBonus(userId) {
  try {
    const settings = await ReferralSettings.getSettings();
    const bonus = settings.signupBonus || {};

    if (!bonus.isActive) return null;
    if (!(bonus.amount > 0)) return null;

    // Claim the payout atomically — only the first caller gets a document back.
    const claimed = await User.findOneAndUpdate(
      { _id: userId, signupBonusPaidAt: null },
      {
        $set: {
          signupBonusPaidAt: new Date(),
          signupBonusType:   bonus.rewardType,
          signupBonusAmount: bonus.amount,
        },
      },
      { new: false },
    );
    if (!claimed) return null;   // already paid, or no such user

    if (bonus.rewardType === 'money') {
      await Wallet.updateOne(
        { user: userId },
        { $inc: { 'balances.NAIRA': bonus.amount } },
        { upsert: true, setOnInsert: { user: userId } },
      );
    } else {
      await User.updateOne({ _id: userId }, { $inc: { rpBalance: bonus.amount } });
    }

    return { type: bonus.rewardType, amount: bonus.amount };
  } catch (err) {
    // A promotion must never block a user from verifying their account.
    console.error('[referralService grantSignupBonus]', err);
    return null;
  }
}

/**
 * Ongoing commission: once a referred user has QUALIFIED, every later purchase
 * earns their referrer a percentage.
 *
 * This is always a gift on top, never a deduction. The referred user is charged
 * the full amount and keeps their full RP — taking the commission out of the
 * sale would understate revenue and distort profit reporting, so it is credited
 * separately to the referrer.
 *
 *   cashback    -> percent of the purchase value, into the referrer's wallet
 *   rewardpoint -> percent of the RP the referred user earned, as RP
 *
 * Bounded by maxPerReferredUser so a single referral cannot generate an
 * open-ended liability.
 */
async function handleCommission(referredUserId, { amount = 0, rpEarned = 0 } = {}) {
  try {
    const settings = await ReferralSettings.getSettings();
    const cfg = settings.referralCommission || {};

    if (!cfg.isActive) return null;
    if (!(cfg.percent > 0)) return null;

    // Only referrals that already paid out their one-off reward qualify.
    const referral = await Referral.findOne({ referred: referredUserId, status: 'rewarded' });
    if (!referral) return null;

    // Base differs by type: money is a share of the sale, RP a share of the
    // points the referred user just earned.
    const base = cfg.type === 'cashback' ? amount : rpEarned;
    if (!(base > 0)) return null;

    let payout = (base * cfg.percent) / 100;

    // Apply the lifetime ceiling for this referred user.
    if (cfg.maxPerReferredUser > 0) {
      const alreadyEarned = referral.commissionEarned || 0;
      const headroom = cfg.maxPerReferredUser - alreadyEarned;
      if (headroom <= 0) return null;             // cap already reached
      if (payout > headroom) payout = headroom;   // partial final payout
    }

    // Round money to kobo; RP to whole points.
    payout = cfg.type === 'cashback'
      ? Math.round(payout * 100) / 100
      : Math.floor(payout);
    if (!(payout > 0)) return null;

    if (cfg.type === 'cashback') {
      await Wallet.updateOne(
        { user: referral.referrer },
        { $inc: { 'balances.NAIRA': payout } },
        { upsert: true, setOnInsert: { user: referral.referrer } },
      );
    } else {
      await User.updateOne({ _id: referral.referrer }, { $inc: { rpBalance: payout } });
    }

    await Referral.updateOne(
      { _id: referral._id },
      {
        $inc: { commissionEarned: payout, commissionCount: 1 },
        $set: { commissionType: cfg.type, commissionLastAt: new Date() },
      },
    );

    return { type: cfg.type, payout, referrer: referral.referrer };
  } catch (err) {
    // Commission is a bonus — it must never fail a completed purchase.
    console.error('[referralService handleCommission]', err);
    return null;
  }
}

module.exports = {
  grantSignupBonus,
  handleCommission,
  ensureReferralCode,
  applyReferralCode,
  handlePurchase,
  randomCode,
  isSystemCode,
  CODE_PREFIX,
  CODE_LEN,
};
