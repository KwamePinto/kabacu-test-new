const crypto = require('crypto');

const User             = require('../models/UserModel');
const Referral         = require('../models/ReferralModel');
const ReferralSettings = require('../models/ReferralSettingsModel');
const ReferralCode = require('../models/ReferralCodeModel');
const referralCodeService = require('./referralCodeService');
const Wallet           = require('../models/WalletModal');
const SpecialCode      = require('../models/SpecialReferralCodeModel');

/**
 * System-generated codes are always KB + 8 digits, 10 characters in total:
 *   KB48120375
 *
 * Digits only after the prefix, so a code can be read aloud or typed on a
 * numeric keypad without letter/number confusion. Admin-created special codes
 * are exempt from this shape entirely — see SpecialReferralCodeModel.
 */
/* Shape, generation and validation all live in referralCodeService now, so
   there is one definition of what a code may look like rather than two that can
   drift apart. Re-exported below to keep the old names working. */
const CODE_PREFIX  = referralCodeService.SYSTEM_PREFIX;
const CODE_DIGITS  = referralCodeService.SYSTEM_DIGITS;
const isSystemCode = referralCodeService.isSystemShape;
const randomCode   = referralCodeService.randomSystemCode;
const CODE_LEN     = CODE_PREFIX.length + CODE_DIGITS; // 10

/**
 * Returns the user's referral code, creating their free system code on first
 * access.
 *
 * Kept as a thin delegate so the three existing callers do not have to change.
 * The real work moved to referralCodeService, which writes the code table as
 * well as User.referralCode — a code created only in the latter would not be
 * resolvable once a user changed it.
 */
async function ensureReferralCode(userId) {
  return referralCodeService.ensurePrimaryCode(userId);
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
  //
  // Resolution goes through the code table, not User.referralCode, and that is
  // the whole point of it: a user who has since moved to a vanity code still
  // owns every code they used to advertise, so an old link keeps crediting
  // them. Falling back to User.referralCode covers accounts that predate the
  // table and have not been migrated yet.
  const [referred, codeRow] = await Promise.all([
    User.findById(userId),
    ReferralCode.findOne({ code }).lean(),
  ]);

  const referrer = codeRow
    ? await User.findById(codeRow.user)
    : await User.findOne({ referralCode: code });

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
  /* A paid code earns its owner more than their free system code. That uplift
     is what a special or custom code is actually sold for, so it is applied
     here, at the moment the reward is calculated.

     The percentage is read off the code row rather than off today's settings:
     it was frozen when the code was bought, so an admin lowering the programme
     bonus never retro-prices somebody's purchase. System codes return 0, which
     is why this can be applied unconditionally.

     Rounded rather than floored so a bonus can never make a reward smaller
     than the base, which floor() would do for any fractional result. */
  const bonuses = await referralCodeService.bonusesForCode(referral.codeUsed);
  const bonusPercent = bonuses.reward;
  const withBonus = (base) =>
    bonusPercent > 0 ? Math.round(base * (1 + bonusPercent / 100)) : base;

  const bonusNote = bonusPercent > 0 ? ` (includes ${bonusPercent}% code bonus)` : '';

  if (settings.rewardType === 'BTT' || settings.rewardType === 'USDT') {
    if (!(settings.amount > 0)) return null;
    const payout = withBonus(settings.amount);
    // A flat wallet field, not a country-market one — BTT and USDT are the
    // same balance in every market, so this never goes through walletUtil.
    await Wallet.updateOne(
      { user: referral.referrer },
      { $inc: { [`balances.${settings.rewardType}`]: payout } },
    );
    return {
      type: settings.rewardType,
      amount: payout,
      bonusPercent,
      note: `${payout} ${settings.rewardType} credited to wallet${bonusNote}`,
    };
  }

  if (settings.rewardType === 'rewardpoint') {
    if (!(settings.amount > 0)) return null;
    const payout = withBonus(settings.amount);
    await User.updateOne({ _id: referral.referrer }, { $inc: { rpBalance: payout } });
    return {
      type: 'rewardpoint',
      amount: payout,
      bonusPercent,
      note: `${payout} RP awarded${bonusNote}`,
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

    /* A paid code can also lift the ongoing commission, on top of the one-off
       reward uplift in grantReward. Set separately by the admin because the two
       carry different risk: the reward is a known one-off, while this applies to
       every future purchase the referred user makes. Zero here means a paid code
       earns the standard commission with no uplift.

       Read off the code row, so it is the percentage that was sold, not today's.
       Applied BEFORE the cap: the cap is a lifetime ceiling on what one referred
       user can generate, and the bonus is part of what they generate — applying
       it afterwards would let a bonus push a payout past the ceiling. */
    const bonuses = await referralCodeService.bonusesForCode(referral.codeUsed);
    if (bonuses.commission > 0) {
      payout = payout * (1 + bonuses.commission / 100);
    }

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

    return {
      type: cfg.type,
      payout,
      bonusPercent: bonuses.commission,
      referrer: referral.referrer,
    };
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
