/**
 * Linking a Kabacu account to its BitToken miner ID.
 *
 * The rules and the BitToken call already existed, inline in
 * packagesController.editUserProfile. They moved here when the signup bonus
 * gained a "link your miner ID" step, because two copies of a validation
 * that decides whether a bonus pays out is exactly the kind of thing that
 * drifts: the profile form would keep one set of length rules and the bonus
 * step another, and a miner ID accepted by one would be rejected by the
 * other with no obvious reason why.
 *
 * BitToken is the authority on whether an ID is real. It matches on the
 * EMAIL AND MINER ID TOGETHER — an ID that exists but belongs to a different
 * BitToken account is rejected — which is what stops one person's ID being
 * used to satisfy everybody's bonus.
 */
const axios = require('axios');
const User = require('../models/UserModel');

// BitToken issues miner IDs in this range. Numbers only: the ID is typed off
// another app's screen, so anything that is not a digit is a typo rather
// than a format we should try to interpret.
const MIN_DIGITS = 8;
const MAX_DIGITS = 11;

const VERIFY_TIMEOUT_MS = 15000;

/** Shape check only — no network, no database. Returns null when fine. */
function shapeError(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return 'Enter your BitToken Miner ID.';
  if (!/^\d+$/.test(trimmed)) return 'Your Miner ID is numbers only — no letters, spaces or symbols.';
  if (trimmed.length < MIN_DIGITS || trimmed.length > MAX_DIGITS) {
    return `A Miner ID is between ${MIN_DIGITS} and ${MAX_DIGITS} digits. Check it on the BitToken app.`;
  }
  return null;
}

function isConfigured() {
  return Boolean(process.env.BITTOKEN_BASE_URL);
}

/**
 * Ask BitToken whether this email and miner ID are the same account.
 *
 * Resolves on a match, throws with a user-safe message otherwise. A failure
 * here is deliberately NOT treated as "probably fine" — this gates a payout,
 * so an unreachable BitToken has to block rather than wave the user through.
 */
async function verifyWithBitToken(email, minerId) {
  if (!isConfigured()) {
    throw new Error('Miner ID checks are not available right now. Please try again later.');
  }

  try {
    await axios.post(
      `${process.env.BITTOKEN_BASE_URL}/api/user/kabacu/verify/user`,
      { email_id: email, miner_id: minerId },
      { timeout: VERIFY_TIMEOUT_MS },
    );
  } catch (err) {
    // A timeout or a dead host is not the user's mistake, and telling them
    // their ID is wrong when it may not be would send them off to "fix"
    // something that is already correct.
    if (!err.response) {
      console.error('[minerId verify] BitToken unreachable:', err.message);
      throw new Error('We could not reach BitToken just now. Please try again in a moment.');
    }
    console.log('[minerId verify] rejected:', err.response?.data || err.message);
    throw new Error(
      `Your email (${email}) and that Miner ID do not belong to the same BitToken account. ` +
      'Check both in the BitToken app — the email here must be the one your miner is registered to.',
    );
  }
}

/**
 * Validate a miner ID and save it onto the user.
 *
 * Returns { success, message, minerId } rather than throwing, so both the
 * profile form (which redirects with a flash) and the bonus step (which
 * answers JSON) can present the same outcome their own way.
 */
async function linkMinerId(userId, rawMinerId) {
  const shapeIssue = shapeError(rawMinerId);
  if (shapeIssue) return { success: false, message: shapeIssue };

  const minerId = Number(String(rawMinerId).trim());

  const user = await User.findById(userId).select('email minerId').lean();
  if (!user) return { success: false, message: 'Account not found.' };

  if (user.minerId === minerId) {
    // Idempotent: re-submitting the ID they already hold is a no-op success,
    // not "already taken" by themselves.
    return { success: true, message: 'That Miner ID is already linked to your account.', minerId };
  }

  /* One miner ID per Kabacu account. Checked before calling BitToken so a
     user is not sent round a network round-trip to be told something we
     already knew, and enforced again by the unique index on the field if two
     requests race. */
  const taken = await User.findOne({ minerId, _id: { $ne: userId } }).select('_id').lean();
  if (taken) {
    return {
      success: false,
      message: 'That Miner ID is already linked to another Kabacu account. Each ID can only be used once.',
    };
  }

  try {
    await verifyWithBitToken(user.email, minerId);
  } catch (err) {
    return { success: false, message: err.message };
  }

  try {
    await User.updateOne({ _id: userId }, { $set: { minerId } });
  } catch (err) {
    if (err && err.code === 11000) {
      return { success: false, message: 'That Miner ID was just linked to another account.' };
    }
    throw err;
  }

  return { success: true, message: 'Miner ID verified and linked.', minerId };
}

module.exports = {
  MIN_DIGITS,
  MAX_DIGITS,
  isConfigured,
  shapeError,
  verifyWithBitToken,
  linkMinerId,
};
