const crypto = require('crypto');

const User = require('../models/UserModel');
const Wallet = require('../models/WalletModal');
const ReferralCode = require('../models/ReferralCodeModel');
const ReferralCodeRequest = require('../models/ReferralCodeRequestModel');
const SpecialCode = require('../models/SpecialReferralCodeModel');
const ReferralSettings = require('../models/ReferralSettingsModel');
const walletUtil = require('../utils/wallet');
const { toCode, DEFAULT_COUNTRY } = require('../utils/country');

/**
 * Everything about owning a referral code: what a code may look like, who owns
 * one, and how a user buys a better one.
 *
 * The reward side of referrals stays in referralService.js. This module only
 * deals in codes — issuing, retiring, validating and selling them.
 */

const SYSTEM_PREFIX = 'KB';
const SYSTEM_DIGITS = 8;

/** Codes are alphanumeric only. See assertUsableShape for why. */
const SHAPE = /^[A-Z0-9]+$/;

/**
 * Words a custom code may not contain.
 *
 * Deliberately short. This is a cheap first pass, not moderation — a blocklist
 * cannot catch creative spelling, which is exactly why every custom code still
 * goes to a human unless an admin has explicitly turned that off. Its job is to
 * stop the obvious cases from ever reaching the queue.
 */
const BLOCKED_FRAGMENTS = [
  'ADMIN', 'KABACU', 'SUPPORT', 'OFFICIAL', 'STAFF', 'MODERATOR',
  'FUCK', 'SHIT', 'CUNT', 'NIGGA', 'NIGGER', 'RAPE', 'NAZI', 'HITLER',
];

function normalise(raw) {
  return String(raw || '').trim().toUpperCase();
}

function isSystemShape(code) {
  return new RegExp(`^${SYSTEM_PREFIX}\\d{${SYSTEM_DIGITS}}$`).test(normalise(code));
}

function randomSystemCode() {
  // crypto.randomInt avoids the modulo bias a randomBytes % 10 would introduce
  let digits = '';
  for (let i = 0; i < SYSTEM_DIGITS; i++) digits += crypto.randomInt(0, 10);
  return SYSTEM_PREFIX + digits;
}

/**
 * Shape rules every code must satisfy, whoever created it.
 *
 * Alphanumeric only, and the reason is concrete rather than stylistic: codes are
 * pasted into a comma-separated box by admins, put in URLs, and read aloud.
 * Allowing a comma would silently split one code into two on paste; allowing
 * whitespace or punctuation would make two visibly identical codes different
 * strings. Restricting the character set removes the whole class of problem.
 *
 * Returns null when fine, or a message naming what is wrong.
 */
function assertUsableShape(code) {
  if (!code) return 'Enter a code.';
  if (code.includes(',')) return 'A code cannot contain a comma — separate multiple codes with commas instead.';
  if (/\s/.test(code)) return 'A code cannot contain spaces.';
  if (!SHAPE.test(code)) return 'Use letters and numbers only — no punctuation or symbols.';
  return null;
}

/**
 * Is this code free to be taken?
 *
 * Checks every place a code can already exist. All three matter:
 *   - an issued code, current or retired, still resolves to its owner
 *   - a reserved pool code is blocked until an admin sells it
 *   - a pending request has effectively claimed the code while it is queued,
 *     otherwise two users could both be approved for the same one
 *
 * `exceptUser` lets a user's own codes pass, so re-requesting something they
 * already hold reports the right reason.
 *
 * `exceptRequest` excludes one pending request from the queued check. Approval
 * needs this: the request being approved is itself pending, so without it every
 * approval would find the code "already requested" — by itself — and refuse.
 */
async function availability(code, { exceptUser = null, exceptRequest = null } = {}) {
  const normalised = normalise(code);

  const queuedFilter = { code: normalised, status: 'pending' };
  if (exceptRequest) queuedFilter._id = { $ne: exceptRequest };

  const [owned, reserved, queued] = await Promise.all([
    ReferralCode.findOne({ code: normalised }).lean(),
    SpecialCode.findOne({ code: normalised }).lean(),
    ReferralCodeRequest.findOne(queuedFilter).lean(),
  ]);

  if (owned) {
    const mine = exceptUser && String(owned.user) === String(exceptUser);
    return { available: false, reason: mine ? 'You already hold this code.' : 'That code is already taken.' };
  }
  if (reserved) {
    // Pool codes are not "taken" — they are for sale. Say so, because the user
    // may well be able to buy this exact one.
    return {
      available: false,
      reason: 'That code is reserved by Kabacu. You may be able to buy it from the reserved list.',
      reservedId: String(reserved._id),
      reservedPrice: reserved.price,
    };
  }
  if (queued) {
    const mine = exceptUser && String(queued.user) === String(exceptUser);
    return {
      available: false,
      reason: mine ? 'You have already requested this code.' : 'Someone else has requested that code.',
    };
  }

  // A legacy account may still carry a code that predates the code table.
  const legacy = await User.findOne({ referralCode: normalised }).select('_id').lean();
  if (legacy && !(exceptUser && String(legacy._id) === String(exceptUser))) {
    return { available: false, reason: 'That code is already taken.' };
  }

  return { available: true, reason: '' };
}

/**
 * Full validation of a user-chosen code, shape and length and availability.
 * Returns { ok, message }.
 */
async function validateCustomCode(rawCode, userId, settings) {
  const code = normalise(rawCode);
  const cfg = (settings && settings.paidCodes && settings.paidCodes.custom) || {};
  const min = cfg.minLength || 4;
  const max = cfg.maxLength || 16;

  const shape = assertUsableShape(code);
  if (shape) return { ok: false, message: shape };

  if (code.length < min) return { ok: false, message: `Use at least ${min} characters.` };
  if (code.length > max) return { ok: false, message: `Use at most ${max} characters.` };

  // A custom code must not impersonate a system one, or the KB######## shape
  // stops meaning "issued free by us".
  if (isSystemShape(code)) {
    return { ok: false, message: `${SYSTEM_PREFIX} followed by ${SYSTEM_DIGITS} digits is reserved for codes we issue.` };
  }

  const hit = BLOCKED_FRAGMENTS.find(w => code.includes(w));
  if (hit) return { ok: false, message: 'That code contains a word we cannot allow. Please choose another.' };

  const avail = await availability(code, { exceptUser: userId });
  if (!avail.available) return { ok: false, message: avail.reason };

  return { ok: true, message: 'That code is available.' };
}

/**
 * The user's current code, creating their free system code on first access.
 *
 * Replaces the old ensureReferralCode: it writes to the code table as well as
 * User.referralCode, so a newly created code is resolvable by the same lookup
 * that resolves retired ones.
 */
async function ensurePrimaryCode(userId) {
  const existing = await ReferralCode.findOne({ user: userId, isPrimary: true }).lean();
  if (existing) return existing.code;

  const user = await User.findById(userId).select('referralCode');
  if (!user) return null;

  // Adopt whatever the account already carries. This is the migration path for
  // every user who had a code before this table existed — their code keeps
  // working and simply gains a row.
  if (user.referralCode) {
    const adopted = normalise(user.referralCode);
    try {
      await ReferralCode.create({
        code: adopted,
        user: userId,
        kind: isSystemShape(adopted) ? 'system' : 'special',
        isPrimary: true,
      });
      return adopted;
    } catch (err) {
      // Another request adopted it first, or the code row already exists.
      if (err && err.code === 11000) {
        const now = await ReferralCode.findOne({ user: userId, isPrimary: true }).lean();
        if (now) return now.code;
      }
      throw err;
    }
  }

  for (let attempt = 0; attempt < 8; attempt++) {
    const code = randomSystemCode();

    // Never hand out something being held back for sale, even if an admin has
    // reserved a code that happens to match the system shape.
    const avail = await availability(code);
    if (!avail.available) continue;

    try {
      const doc = await ReferralCode.create({ code, user: userId, kind: 'system', isPrimary: true });
      await User.updateOne({ _id: userId }, { $set: { referralCode: doc.code } });
      return doc.code;
    } catch (err) {
      if (err && err.code === 11000) continue; // collided, try another
      throw err;
    }
  }
  throw new Error('Could not allocate a unique referral code');
}

/**
 * Make `code` the user's advertised code, retiring whatever was primary.
 *
 * The retired row is left in place and still owned by the same user, which is
 * what keeps an old code crediting them after they have moved on. Nothing is
 * ever deleted here.
 */
async function issueCode(userId, code, {
  kind,
  pricePaid = 0,
  rewardBonusPercent = 0,
  commissionBonusPercent = 0,
  specialCode = null,
  request = null,
} = {}) {
  const normalised = normalise(code);

  // Demote the current primary first. Done before the insert because the
  // partial unique index allows only one primary per user, so inserting first
  // would collide with the row we are about to retire.
  await ReferralCode.updateOne(
    { user: userId, isPrimary: true },
    { $set: { isPrimary: false, retiredAt: new Date() } },
  );

  let doc;
  try {
    doc = await ReferralCode.create({
      code: normalised,
      user: userId,
      kind,
      isPrimary: true,
      pricePaid,
      rewardBonusPercent,
      commissionBonusPercent,
      specialCode,
      request,
    });
  } catch (err) {
    // The user already holds this code — promote the row they have rather than
    // leaving them with no primary at all.
    if (err && err.code === 11000) {
      await ReferralCode.updateOne(
        { code: normalised, user: userId },
        { $set: { isPrimary: true, retiredAt: null, kind, pricePaid, rewardBonusPercent, commissionBonusPercent } },
      );
      doc = await ReferralCode.findOne({ code: normalised, user: userId });
    } else {
      throw err;
    }
  }

  await User.updateOne({ _id: userId }, { $set: { referralCode: normalised } });
  return doc;
}

/** Every code a user has ever held, primary first then newest. */
async function historyFor(userId) {
  return ReferralCode.find({ user: userId })
    .sort({ isPrimary: -1, createdAt: -1 })
    .lean();
}

/**
 * What a code of each kind costs and earns right now.
 *
 * `specialPriceFor` exists because a pool code may carry its own price: the
 * per-code value wins when set, and the settings default fills in otherwise.
 */
function pricingFrom(settings) {
  const p = (settings && settings.paidCodes) || {};
  const sp = p.special || {};
  const cu = p.custom || {};
  return {
    isActive:    !!p.isActive,
    autoApprove: !!p.autoApprove,
    special: {
      price:                  sp.price || 0,
      currency:               sp.currency || 'BTT',
      rewardBonusPercent:     sp.rewardBonusPercent || 0,
      commissionBonusPercent: sp.commissionBonusPercent || 0,
    },
    custom: {
      price:                  cu.price || 0,
      rewardBonusPercent:     cu.rewardBonusPercent || 0,
      commissionBonusPercent: cu.commissionBonusPercent || 0,
      minLength:              cu.minLength || 4,
      maxLength:              cu.maxLength || 16,
    },
  };
}

/**
 * What a pool code costs right now, and what it costs it in.
 *
 * A code's own price and currency travel together — a code priced in USDT
 * cannot fall back to a BTT default for its number while keeping the
 * settings' currency, or the two would describe different amounts entirely.
 * So the pair comes from the code row if it has set a real price, and from
 * settings only when it has not.
 */
function specialPriceFor(specialDoc, settings) {
  const fallback = pricingFrom(settings).special;
  if (specialDoc && specialDoc.price > 0) {
    return { price: specialDoc.price, currency: specialDoc.currency || fallback.currency };
  }
  return { price: fallback.price, currency: fallback.currency };
}

/** Flat wallet balance for a currency that is not market-scoped (BTT, USDT). */
function flatBalance(wallet, currency) {
  return Number((wallet && wallet.balances && wallet.balances[currency]) || 0);
}

/**
 * The two bonus percentages that apply to a referral which arrived on `code`.
 *
 * Reads the snapshot on the code row, not today's settings — a user who bought
 * a 25% code keeps 25% even if the programme later drops to 10%.
 *
 * Returns zeros for system codes and for anything unrecognised, so callers can
 * multiply unconditionally rather than branching on whether a bonus exists.
 */
async function bonusesForCode(code) {
  const none = { reward: 0, commission: 0 };
  if (!code) return none;

  const row = await ReferralCode.findOne({ code: normalise(code) })
    .select('rewardBonusPercent commissionBonusPercent kind')
    .lean();

  if (!row || row.kind === 'system') return none;
  return {
    reward:     Number(row.rewardBonusPercent) || 0,
    commission: Number(row.commissionBonusPercent) || 0,
  };
}

/* ── Buying a code ───────────────────────────────────────────────────────── */

/**
 * Record a request to buy a code.
 *
 * Nothing is charged and nothing is issued here unless auto-approve is on. The
 * balance check is advisory — it stops a user queueing something they cannot
 * afford — but the debit that matters happens at approval.
 */
async function requestCode(userId, { type, code, specialId } = {}) {
  const settings = await ReferralSettings.getSettings();
  const pricing = pricingFrom(settings);

  if (!pricing.isActive) {
    return { success: false, message: 'Custom referral codes are not on sale at the moment.' };
  }

  const existing = await ReferralCodeRequest.findOne({ user: userId, status: 'pending' }).lean();
  if (existing) {
    return {
      success: false,
      message: `You already have a request for ${existing.code} awaiting review. It has to be settled before you can ask for another.`,
    };
  }

  const user = await User.findById(userId).select('walletCountry username').lean();
  if (!user) return { success: false, message: 'Account not found.' };
  const market = walletUtil.marketOf(user.walletCountry);

  let wanted;
  let price;
  let currency = null; // set only for 'special' — 'custom' stays market-priced
  let bonuses;
  let specialDoc = null;

  if (type === 'special') {
    specialDoc = await SpecialCode.findById(specialId);
    if (!specialDoc) return { success: false, message: 'That code is no longer listed.' };
    if (!specialDoc.isActive) return { success: false, message: 'That code is not available.' };
    if (specialDoc.permittedUser) return { success: false, message: 'That code has already been taken.' };

    wanted = specialDoc.code;
    ({ price, currency } = specialPriceFor(specialDoc, settings));
    bonuses = {
      reward:     pricing.special.rewardBonusPercent,
      commission: pricing.special.commissionBonusPercent,
    };

    // Two users can reach the list at the same moment; the pending-request
    // check is what stops both being queued for the same code.
    const claimed = await ReferralCodeRequest.findOne({ code: wanted, status: 'pending' }).lean();
    if (claimed) return { success: false, message: 'Someone else has just requested that code.' };
  } else if (type === 'custom') {
    wanted = normalise(code);
    const check = await validateCustomCode(wanted, userId, settings);
    if (!check.ok) return { success: false, message: check.message };

    price = pricing.custom.price;
    bonuses = {
      reward:     pricing.custom.rewardBonusPercent,
      commission: pricing.custom.commissionBonusPercent,
    };
  } else {
    return { success: false, message: 'Choose a reserved code or a custom one.' };
  }

  // Advisory affordability check. Approval re-checks atomically.
  if (price > 0) {
    const wallet = await Wallet.findOne({ user: userId }).lean();
    // A special code is priced in BTT/USDT — a flat balance, not a market one —
    // so it reads a different field than a custom code, which stays priced in
    // whatever the requester's market wallet holds.
    const balance = currency ? flatBalance(wallet, currency) : walletUtil.getBalance(wallet, market);
    const unit = currency ? ` ${currency}` : '';
    if (balance < price) {
      return {
        success: false,
        message: `This code costs ${price.toLocaleString()}${unit}. Your wallet has ${balance.toLocaleString()}${unit} — top up first.`,
      };
    }
  }

  let request;
  try {
    request = await ReferralCodeRequest.create({
      user: userId,
      type,
      code: wanted,
      specialCode: specialDoc ? specialDoc._id : null,
      price,
      currency,
      rewardBonusPercent:     bonuses.reward,
      commissionBonusPercent: bonuses.commission,
      walletCountry: market,
      status: 'pending',
    });
  } catch (err) {
    // Unique partial index on (user, pending) — lost a race with themselves.
    if (err && err.code === 11000) {
      return { success: false, message: 'You already have a request awaiting review.' };
    }
    throw err;
  }

  if (pricing.autoApprove) {
    const result = await approveRequest(request._id, { reviewer: 'auto-approve', auto: true });
    return result.success
      ? { success: true, autoApproved: true, message: result.message, code: wanted }
      : { success: false, message: result.message };
  }

  return {
    success: true,
    autoApproved: false,
    message: price > 0
      ? `Request for ${wanted} sent for review. Nothing has been charged yet — your wallet is debited only once it is approved.`
      : `Request for ${wanted} sent for review.`,
    code: wanted,
    currency,
  };
}

/**
 * Approve a request: charge the wallet, then issue the code.
 *
 * Order matters and is not interchangeable. The charge is claimed first with a
 * compare-and-swap on `charged`, so a double-click cannot bill twice; the code
 * is issued only after the money has actually moved. If the debit fails for
 * want of funds nothing else has happened yet, so the request simply stays
 * pending and can be approved again later.
 */
async function approveRequest(requestId, { reviewer = 'admin', auto = false } = {}) {
  const request = await ReferralCodeRequest.findOne({ _id: requestId, status: 'pending' });
  if (!request) return { success: false, message: 'That request is no longer pending.' };

  /* Re-check availability at approval time: the queue may have sat for days and
     the code could have been taken or reserved since.

     exceptRequest is essential, not defensive. This request is itself pending,
     so without excluding it the check finds the code "already requested" — by
     the very request being approved — and every approval fails. */
  const avail = await availability(request.code, {
    exceptUser: request.user,
    exceptRequest: request._id,
  });
  if (!avail.available && request.type === 'custom') {
    return { success: false, message: `Cannot issue ${request.code}: ${avail.reason}` };
  }

  if (request.type === 'special') {
    const special = await SpecialCode.findById(request.specialCode);
    if (!special) return { success: false, message: 'The reserved code no longer exists.' };
    if (special.permittedUser && String(special.permittedUser) !== String(request.user)) {
      return { success: false, message: 'That reserved code has already gone to someone else.' };
    }
  }

  const market = walletUtil.marketOf(request.walletCountry);

  if (request.price > 0) {
    /* Claim the charge before moving money. Whoever flips `charged` from false
       to true owns the debit; a second attempt finds nothing to claim and stops
       rather than billing again. */
    const claimed = await ReferralCodeRequest.findOneAndUpdate(
      { _id: request._id, status: 'pending', charged: { $ne: true } },
      { $set: { charged: true } },
      { new: false },
    );
    if (!claimed) return { success: false, message: 'That request is already being processed.' };

    /* Conditional debit: the balance test and the decrement are one operation,
       so a wallet can never be driven negative by a concurrent purchase.

       A special-code request carries its own currency and is charged against
       that flat balance (BTT/USDT) directly — it is not a market purchase, so
       it does not go through walletUtil's country-wallet routing. A custom
       code has no currency recorded and keeps charging the requester's market
       wallet, exactly as before. */
    const path = request.currency ? `balances.${request.currency}` : walletUtil.balancePath(market);
    const readBalance = (doc) => (request.currency ? flatBalance(doc, request.currency) : walletUtil.getBalance(doc, market));

    const before = await Wallet.findOneAndUpdate(
      { user: request.user, [path]: { $gte: request.price } },
      { $inc: { [path]: -request.price } },
      { new: false },
    );

    if (!before) {
      // Release the claim so the request can be approved once they top up.
      await ReferralCodeRequest.updateOne({ _id: request._id }, { $set: { charged: false } });
      const wallet = await Wallet.findOne({ user: request.user }).lean();
      const balance = readBalance(wallet);
      const unit = request.currency ? ` ${request.currency}` : '';
      return {
        success: false,
        message: `Not enough in their wallet: ${balance.toLocaleString()}${unit} against a price of ${request.price.toLocaleString()}${unit}. The request is still pending.`,
      };
    }

    request.balanceBefore = readBalance(before);
    request.balanceAfter = request.balanceBefore - request.price;
  }

  const issued = await issueCode(request.user, request.code, {
    kind: request.type,
    pricePaid: request.price,
    // From the request, not from settings: these are the terms the user accepted.
    rewardBonusPercent: request.rewardBonusPercent,
    commissionBonusPercent: request.commissionBonusPercent,
    specialCode: request.specialCode,
    request: request._id,
  });

  if (request.type === 'special' && request.specialCode) {
    // Mark the pool row as gone so it leaves the list for everyone else.
    const previous = await ReferralCode.findOne({
      user: request.user, isPrimary: false, retiredAt: { $ne: null },
    }).sort({ retiredAt: -1 }).select('code').lean();

    await SpecialCode.updateOne(
      { _id: request.specialCode },
      {
        $set: {
          permittedUser: request.user,
          assignedAt: new Date(),
          previousUserCode: previous ? previous.code : null,
        },
      },
    );
  }

  request.status = 'approved';
  request.reviewedBy = reviewer;
  request.reviewedAt = new Date();
  request.autoApproved = auto;
  request.issuedCode = issued._id;
  await request.save();

  return {
    success: true,
    message: `${request.code} issued.` + (request.price > 0 ? ` ${request.price.toLocaleString()} charged.` : ''),
    request,
  };
}

/**
 * Reject a request. Nothing to refund — approval is what charges, so a rejected
 * request never touched the balance.
 */
async function rejectRequest(requestId, { reviewer = 'admin', reason = '' } = {}) {
  const trimmed = String(reason || '').trim();
  if (!trimmed) return { success: false, message: 'Give a reason — the user is shown this.' };

  const request = await ReferralCodeRequest.findOneAndUpdate(
    { _id: requestId, status: 'pending' },
    {
      $set: {
        status: 'rejected',
        rejectionReason: trimmed,
        reviewedBy: reviewer,
        reviewedAt: new Date(),
      },
    },
    { new: true },
  );

  if (!request) return { success: false, message: 'That request is no longer pending.' };
  return { success: true, message: `Request for ${request.code} rejected.`, request };
}

/** A user withdrawing their own pending request. */
async function cancelRequest(requestId, userId) {
  const request = await ReferralCodeRequest.findOneAndUpdate(
    { _id: requestId, user: userId, status: 'pending' },
    { $set: { status: 'cancelled', reviewedAt: new Date() } },
    { new: true },
  );
  if (!request) return { success: false, message: 'No pending request to cancel.' };
  return { success: true, message: `Request for ${request.code} withdrawn.` };
}

/**
 * Bulk-create pool codes from one pasted, comma-separated string.
 *
 * Reports every code individually rather than failing the whole paste on one
 * bad entry: an admin pasting fifty codes from a spreadsheet wants the
 * forty-nine good ones created and to be told which one was wrong.
 */
async function bulkCreateSpecialCodes(raw, { price = 0, currency = 'BTT', note = '', createdBy = 'admin' } = {}) {
  // Split on commas, and tolerate newlines and semicolons too — pasting a
  // column out of a spreadsheet yields newlines, and refusing that would be
  // pedantic when the intent is obvious.
  const parts = String(raw || '')
    .split(/[,;\n\r\t]+/)
    .map(normalise)
    .filter(Boolean);

  if (!parts.length) return { success: false, message: 'Nothing to add. Paste codes separated by commas.' };

  const created = [];
  const skipped = [];
  const rejected = [];
  const seen = new Set();

  for (const code of parts) {
    // Duplicates within the paste itself, before touching the database.
    if (seen.has(code)) {
      skipped.push({ code, reason: 'repeated in your list' });
      continue;
    }
    seen.add(code);

    const shape = assertUsableShape(code);
    if (shape) {
      rejected.push({ code, reason: shape });
      continue;
    }

    const avail = await availability(code);
    if (!avail.available) {
      skipped.push({ code, reason: avail.reason.replace(/\.$/, '').toLowerCase() });
      continue;
    }

    try {
      const doc = await SpecialCode.create({ code, price, currency: price > 0 ? currency : null, note, createdBy });
      created.push(doc.code);
    } catch (err) {
      if (err && err.code === 11000) {
        skipped.push({ code, reason: 'already reserved' });
      } else {
        rejected.push({ code, reason: 'could not be saved' });
      }
    }
  }

  const bits = [];
  if (created.length) bits.push(`${created.length} reserved`);
  if (skipped.length) bits.push(`${skipped.length} skipped`);
  if (rejected.length) bits.push(`${rejected.length} rejected`);

  return {
    success: created.length > 0,
    message: bits.join(', ') + '.',
    created,
    skipped,
    rejected,
  };
}

module.exports = {
  SYSTEM_PREFIX,
  SYSTEM_DIGITS,
  BLOCKED_FRAGMENTS,
  normalise,
  isSystemShape,
  randomSystemCode,
  assertUsableShape,
  availability,
  validateCustomCode,
  ensurePrimaryCode,
  issueCode,
  historyFor,
  pricingFrom,
  specialPriceFor,
  bonusesForCode,
  requestCode,
  approveRequest,
  rejectRequest,
  cancelRequest,
  bulkCreateSpecialCodes,
};
