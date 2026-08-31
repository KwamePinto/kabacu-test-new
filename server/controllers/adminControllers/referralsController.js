const ReferralSettings = require('../../models/ReferralSettingsModel');
const Referral         = require('../../models/ReferralModel');
const SpecialCode = require('../../models/SpecialReferralCodeModel');
const User = require('../../models/UserModel');
const referralService = require('../../services/referralService');
const referralCodeService = require('../../services/referralCodeService');
const ReferralCode = require('../../models/ReferralCodeModel');
const ReferralCodeRequest = require('../../models/ReferralCodeRequestModel');
const { notify } = require('../../services/userNotificationService');
const { authenticateAdminUser } = require('../../config/authMiddleware');

exports.viewPanel = [authenticateAdminUser, async (req, res) => {
  try {
    const settings = await ReferralSettings.getSettings();

    const [referrals, counts] = await Promise.all([
      Referral.find()
        .sort({ createdAt: -1 })
        .limit(100)
        .populate('referrer', 'username email')
        .populate('referred', 'username email')
        .lean(),
      Referral.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
    ]);

    const stats = { pending: 0, qualified: 0, rewarded: 0, void: 0 };
    counts.forEach(c => { if (c._id in stats) stats[c._id] = c.n; });

    // Premium / vanity codes held for sale.
    const specialCodes = await SpecialCode.find()
      .sort({ createdAt: -1 })
      .populate('permittedUser', 'username email')
      .lean();

    /* The review queue. Pending requests are rendered with the page rather
       than fetched afterwards so an admin opening the panel sees outstanding
       work immediately instead of after a spinner. */
    const [codeRequests, requestCounts, codeKindCounts] = await Promise.all([
      ReferralCodeRequest.find({ status: 'pending' })
        .sort({ createdAt: 1 })                       // oldest first: FIFO queue
        .limit(100)
        .populate('user', 'username email phone_number walletCountry')
        .lean(),
      ReferralCodeRequest.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
      ReferralCode.aggregate([{ $group: { _id: '$kind', n: { $sum: 1 } } }]),
    ]);

    const requestStats = { pending: 0, approved: 0, rejected: 0, cancelled: 0 };
    requestCounts.forEach(c => { if (c._id in requestStats) requestStats[c._id] = c.n; });

    const codeStats = { system: 0, special: 0, custom: 0 };
    codeKindCounts.forEach(c => { if (c._id in codeStats) codeStats[c._id] = c.n; });

    res.render('adminview/referrals', {
      layout: 'layouts/adminLayout',
      settings,
      referrals,
      stats,
      specialCodes,
      codeRequests,
      requestStats,
      codeStats,
      csrfToken: res.locals.csrfToken,
    });
  } catch (err) {
    console.error('[referrals viewPanel]', err);
    res.render('adminview/referrals', {
      layout: 'layouts/adminLayout',
      settings: { rewardType: 'rewardpoint', amount: 0, isActive: true, minPurchaseAmount: 0, maxRewardsPerReferrer: 0 },
      referrals: [], specialCodes: [],
      stats: { pending: 0, qualified: 0, rewarded: 0, void: 0 },
      codeRequests: [],
      requestStats: { pending: 0, approved: 0, rejected: 0, cancelled: 0 },
      codeStats: { system: 0, special: 0, custom: 0 },
      csrfToken: res.locals.csrfToken,
    });
  }
}];

exports.saveSettings = [authenticateAdminUser, async (req, res) => {
  try {
    const { rewardType, amount, minPurchaseAmount, maxRewardsPerReferrer, isActive } = req.body;

    if (!['rewardpoint', 'BTT', 'USDT'].includes(rewardType)) {
      return res.json({ success: false, message: 'Pick a valid reward type.' });
    }

    const update = {
      rewardType,
      isActive: isActive !== false && isActive !== 'false',
      minPurchaseAmount: Math.max(0, Number(minPurchaseAmount) || 0),
      maxRewardsPerReferrer: Math.max(0, Number(maxRewardsPerReferrer) || 0),
    };

    // ── Signup bonus promotion ──────────────────────────────────────────
    // Same three currencies as the referral reward. Data is not offered: a
    // bundle needs a destination phone number a brand-new account has not
    // supplied.
    const sbType = ['rewardpoint', 'BTT', 'USDT'].includes(req.body.signupBonusType)
      ? req.body.signupBonusType : 'rewardpoint';
    const sbActive = req.body.signupBonusActive === true || req.body.signupBonusActive === 'true';
    const sbAmount = Math.max(0, Number(req.body.signupBonusAmount) || 0);

    if (sbActive && !(sbAmount > 0)) {
      return res.json({ success: false, message: 'Set a signup bonus amount above zero, or switch the promotion off.' });
    }

    update.signupBonus = { isActive: sbActive, rewardType: sbType, amount: sbAmount };

    // ── Ongoing referral commission ─────────────────────────────────────
    // Same three currencies as the reward and the signup bonus.
    const rcType = ['rewardpoint', 'BTT', 'USDT'].includes(req.body.commissionType)
      ? req.body.commissionType : 'rewardpoint';
    const rcActive = req.body.commissionActive === true || req.body.commissionActive === 'true';
    const rcPercent = Math.max(0, Math.min(100, Number(req.body.commissionPercent) || 0));
    const rcCap = Math.max(0, Number(req.body.commissionMaxPerReferredUser) || 0);

    if (rcActive && !(rcPercent > 0)) {
      return res.json({ success: false, message: 'Set a commission percentage above zero, or switch it off.' });
    }

    update.referralCommission = {
      isActive: rcActive,
      type: rcType,
      percent: rcPercent,
      maxPerReferredUser: rcCap,
    };

    const amt = Number(amount);
    if (!(amt > 0)) {
      return res.json({ success: false, message: 'Enter a reward amount greater than zero.' });
    }
    update.amount = amt;

    // ── Paid codes: special and custom, priced and bonused separately ────
    const pcActive = req.body.paidCodesActive === true || req.body.paidCodesActive === 'true';
    const pcAuto   = req.body.paidCodesAutoApprove === true || req.body.paidCodesAutoApprove === 'true';

    const pct = (v) => Math.max(0, Math.min(500, Number(v) || 0));

    const spPrice    = Math.max(0, Number(req.body.specialPrice) || 0);
    const spCurrency = ['BTT', 'USDT'].includes(req.body.specialCurrency) ? req.body.specialCurrency : 'BTT';
    const spReward   = pct(req.body.specialRewardBonus);
    const spComm     = pct(req.body.specialCommissionBonus);
    const cuPrice   = Math.max(0, Number(req.body.customPrice) || 0);
    const cuReward  = pct(req.body.customRewardBonus);
    const cuComm    = pct(req.body.customCommissionBonus);
    const cuMin     = Math.max(3, Math.min(32, Number(req.body.customMinLength) || 4));
    const cuMax     = Math.max(4, Math.min(64, Number(req.body.customMaxLength) || 16));

    if (cuMin > cuMax) {
      return res.json({ success: false, message: 'The custom code minimum length cannot exceed the maximum.' });
    }

    /* A commission bonus with no commission programme running pays nothing, so
       say that rather than saving a setting that silently does nothing. */
    if ((spComm > 0 || cuComm > 0) && !rcActive) {
      return res.json({
        success: false,
        message: 'A commission bonus only pays out while the ongoing commission is running. Switch that on, or set the commission bonuses to 0.',
      });
    }

    update.paidCodes = {
      isActive: pcActive,
      autoApprove: pcAuto,
      special: {
        price: spPrice,
        currency: spCurrency,
        rewardBonusPercent: spReward,
        commissionBonusPercent: spComm,
      },
      custom: {
        price: cuPrice,
        rewardBonusPercent: cuReward,
        commissionBonusPercent: cuComm,
        minLength: cuMin,
        maxLength: cuMax,
      },
    };

    const settings = await ReferralSettings.getSettings();
    await ReferralSettings.updateOne({ _id: settings._id }, { $set: update });

    res.json({ success: true, message: 'Referral settings saved.' });
  } catch (err) {
    console.error('[referrals saveSettings]', err);
    res.json({ success: false, message: 'Server error. Please try again.' });
  }
}];

// =============================================================================
// SPECIAL / VANITY CODES  (admin-only — no client-facing purchase flow yet)
// =============================================================================
// A special code is reserved the moment it is created, and stays BLOCKED from
// the whole system until an admin assigns it to a specific user. Only on
// assignment is it written onto that user's account, which is what makes it
// usable as a referral code at all.

exports.createSpecialCode = [authenticateAdminUser, async (req, res) => {
  try {
    const code     = String(req.body.code || '').trim().toUpperCase();
    const price    = Math.max(0, Number(req.body.price) || 0);
    const currency = ['BTT', 'USDT'].includes(req.body.currency) ? req.body.currency : 'BTT';
    const note     = String(req.body.note || '').trim();

    if (!code) return res.json({ success: false, message: 'Enter a code.' });
    if (/\s/.test(code)) {
      return res.json({ success: false, message: 'A code cannot contain spaces.' });
    }

    // Must not clash with a reserved code, or one a user already holds.
    if (await SpecialCode.exists({ code })) {
      return res.json({ success: false, message: 'That code is already reserved.' });
    }
    if (await User.exists({ referralCode: code })) {
      return res.json({ success: false, message: 'That code is already in use by a user.' });
    }

    const doc = await SpecialCode.create({
      code, price, currency: price > 0 ? currency : null, note,
      createdBy: (req.user && req.user.username) || 'admin',
    });

    res.json({
      success: true,
      message: code + ' reserved. Assign it to a user to make it usable.',
      specialCode: doc,
    });
  } catch (err) {
    console.error('[referrals createSpecialCode]', err);
    res.json({ success: false, message: 'Server error. Please try again.' });
  }
}];

/**
 * Edit a pool code's own creation details — code, price, currency, note.
 *
 * Restricted to codes nobody holds yet. Once a code has been sold, its price
 * and currency are frozen on the request/ReferralCode row that was actually
 * charged (see approveRequest) — editing the pool row afterward would not
 * touch what that buyer paid, so it would only be misleading. Renaming the
 * code text on a sold row would be worse: the user's account would still say
 * the old code, and the two would silently disagree.
 */
exports.editSpecialCode = [authenticateAdminUser, async (req, res) => {
  try {
    const special = await SpecialCode.findById(req.params.id);
    if (!special) return res.json({ success: false, message: 'Code not found.' });
    if (special.permittedUser) {
      return res.json({ success: false, message: 'This code has already been sold — take it back first if it needs to change.' });
    }

    const code  = String(req.body.code || '').trim().toUpperCase();
    const price = Math.max(0, Number(req.body.price) || 0);
    const currency = ['BTT', 'USDT'].includes(req.body.currency) ? req.body.currency : 'BTT';
    const note  = String(req.body.note || '').trim();

    if (!code) return res.json({ success: false, message: 'Enter a code.' });
    if (/\s/.test(code)) {
      return res.json({ success: false, message: 'A code cannot contain spaces.' });
    }

    if (code !== special.code) {
      // Same clash checks createSpecialCode runs, excluding this row itself.
      if (await SpecialCode.exists({ code, _id: { $ne: special._id } })) {
        return res.json({ success: false, message: 'That code is already reserved.' });
      }
      if (await User.exists({ referralCode: code })) {
        return res.json({ success: false, message: 'That code is already in use by a user.' });
      }
    }

    special.code = code;
    special.price = price;
    special.currency = price > 0 ? currency : null;
    special.note = note;
    await special.save();

    res.json({ success: true, message: code + ' updated.', specialCode: special });
  } catch (err) {
    console.error('[referrals editSpecialCode]', err);
    res.json({ success: false, message: 'Server error. Please try again.' });
  }
}];

/** Look a user up by email or username so the admin never needs an id. */
exports.lookupUser = [authenticateAdminUser, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ success: false, message: 'Enter an email or username.' });

    const user = await User.findOne({
      $or: [{ email: q.toLowerCase() }, { username: q }],
    }).select('username email referralCode').lean();

    if (!user) return res.json({ success: false, message: 'No user with that email or username.' });
    res.json({ success: true, user });
  } catch (err) {
    console.error('[referrals lookupUser]', err);
    res.json({ success: false, message: 'Server error.' });
  }
}];

/**
 * Permits one user to hold the code and writes it onto their account.
 * Their previous code is stored so the assignment can be reversed.
 */
exports.assignSpecialCode = [authenticateAdminUser, async (req, res) => {
  try {
    const special = await SpecialCode.findById(req.params.id);
    if (!special) return res.json({ success: false, message: 'Code not found.' });
    if (!special.isActive) return res.json({ success: false, message: 'That code is inactive.' });
    if (special.permittedUser) {
      return res.json({ success: false, message: 'That code is already assigned.' });
    }

    const q = String(req.body.user || '').trim();
    const user = await User.findOne({ $or: [{ email: q.toLowerCase() }, { username: q }] });
    if (!user) return res.json({ success: false, message: 'No user with that email or username.' });

    // Check the unique index rather than letting the write blow up.
    const clash = await User.exists({ referralCode: special.code, _id: { $ne: user._id } });
    if (clash) {
      return res.json({ success: false, message: 'That code is already in use by another user.' });
    }

    special.previousUserCode = user.referralCode || null;
    special.permittedUser    = user._id;
    special.assignedAt       = new Date();
    await special.save();

    user.referralCode = special.code;
    await user.save();

    res.json({
      success: true,
      message: special.code + ' assigned to ' + user.username +
               '. Previous code (' + (special.previousUserCode || 'none') + ') kept for reversal.',
    });
  } catch (err) {
    console.error('[referrals assignSpecialCode]', err);
    res.json({ success: false, message: 'Server error. Please try again.' });
  }
}];

/** Takes the code back and restores the user's previous one. */
exports.unassignSpecialCode = [authenticateAdminUser, async (req, res) => {
  try {
    const special = await SpecialCode.findById(req.params.id);
    if (!special) return res.json({ success: false, message: 'Code not found.' });
    if (!special.permittedUser) {
      return res.json({ success: false, message: 'That code is not assigned to anyone.' });
    }

    const user = await User.findById(special.permittedUser);
    if (user) {
      let restore = special.previousUserCode;
      // Don't restore a code someone else has taken in the meantime.
      if (restore) {
        const taken = await User.exists({ referralCode: restore, _id: { $ne: user._id } });
        if (taken) restore = null;
      }
      user.referralCode = restore || undefined;
      await user.save();

      // No usable previous code — mint a fresh KB######## one.
      if (!restore) {
        await referralService.ensureReferralCode(user._id);
      }
    }

    special.permittedUser    = null;
    special.assignedAt       = null;
    special.previousUserCode = null;
    await special.save();

    res.json({ success: true, message: special.code + ' released back to the reserved pool.' });
  } catch (err) {
    console.error('[referrals unassignSpecialCode]', err);
    res.json({ success: false, message: 'Server error. Please try again.' });
  }
}];

exports.toggleSpecialCode = [authenticateAdminUser, async (req, res) => {
  try {
    const special = await SpecialCode.findById(req.params.id);
    if (!special) return res.json({ success: false, message: 'Code not found.' });
    special.isActive = !special.isActive;
    await special.save();
    res.json({ success: true, isActive: special.isActive });
  } catch (err) {
    console.error('[referrals toggleSpecialCode]', err);
    res.json({ success: false, message: 'Server error.' });
  }
}];

exports.deleteSpecialCode = [authenticateAdminUser, async (req, res) => {
  try {
    const special = await SpecialCode.findById(req.params.id);
    if (!special) return res.json({ success: false, message: 'Code not found.' });
    if (special.permittedUser) {
      return res.json({
        success: false,
        message: 'Unassign it first — a user is currently holding this code.',
      });
    }
    await SpecialCode.deleteOne({ _id: special._id });
    res.json({ success: true, message: 'Reserved code deleted.' });
  } catch (err) {
    console.error('[referrals deleteSpecialCode]', err);
    res.json({ success: false, message: 'Server error.' });
  }
}];

/* ── Bulk reservation ───────────────────────────────────────────────────────
   One textarea, comma separated, so an admin can paste a column straight out
   of a spreadsheet. Every code is reported on individually: pasting fifty and
   having the whole lot rejected because one was malformed would be useless. */

exports.bulkCreateSpecialCodes = [authenticateAdminUser, async (req, res) => {
  try {
    const price = Math.max(0, Number(req.body.price) || 0);
    const currency = ['BTT', 'USDT'].includes(req.body.currency) ? req.body.currency : 'BTT';
    const note = String(req.body.note || '').trim();

    const result = await referralCodeService.bulkCreateSpecialCodes(req.body.codes, {
      price,
      currency,
      note,
      createdBy: (req.user && req.user.username) || 'admin',
    });

    res.json(result);
  } catch (err) {
    console.error('[referrals bulkCreateSpecialCodes]', err);
    res.json({ success: false, message: 'Server error. Please try again.' });
  }
}];

/* ── The review queue ───────────────────────────────────────────────────────
   A custom code is text one user writes that other users then see, so a person
   reads it before it goes live. Approving is also what charges the wallet — see
   referralCodeService.approveRequest for why the money moves at that point and
   not at request time. */

exports.listCodeRequests = [authenticateAdminUser, async (req, res) => {
  try {
    const status = ['pending', 'approved', 'rejected', 'cancelled'].includes(req.query.status)
      ? req.query.status
      : 'pending';

    const requests = await ReferralCodeRequest.find({ status })
      .sort({ createdAt: status === 'pending' ? 1 : -1 })   // oldest first while queued
      .limit(200)
      .populate('user', 'username email phone_number country walletCountry')
      .lean();

    res.json({
      success: true,
      status,
      requests,
      pendingCount: await ReferralCodeRequest.countDocuments({ status: 'pending' }),
    });
  } catch (err) {
    console.error('[referrals listCodeRequests]', err);
    res.json({ success: false, message: 'Server error.' });
  }
}];

exports.approveCodeRequest = [authenticateAdminUser, async (req, res) => {
  try {
    const result = await referralCodeService.approveRequest(req.params.id, {
      reviewer: (req.user && req.user.username) || 'admin',
    });

    if (result.success && result.request) {
      try {
        await notify(result.request.user, {
          type: 'success',
          text: `Your referral code ${result.request.code} is now active.` +
                (result.request.price > 0
                  ? ` ${result.request.price.toLocaleString()} was charged to your wallet.`
                  : ''),
          link: '/referrals',
        });
      } catch (notifyErr) {
        // A missed notification must not undo an issued code.
        console.log('[code request notify]', notifyErr.message);
      }
    }

    res.json(result);
  } catch (err) {
    console.error('[referrals approveCodeRequest]', err);
    res.json({ success: false, message: 'Server error. Please try again.' });
  }
}];

exports.rejectCodeRequest = [authenticateAdminUser, async (req, res) => {
  try {
    const result = await referralCodeService.rejectRequest(req.params.id, {
      reviewer: (req.user && req.user.username) || 'admin',
      reason: req.body.reason,
    });

    if (result.success && result.request) {
      try {
        await notify(result.request.user, {
          type: 'attention',
          // The reason is included deliberately: a user told only "rejected"
          // will simply request the same thing again.
          text: `Your request for the referral code ${result.request.code} was not approved. ${result.request.rejectionReason}`,
          link: '/referrals',
        });
      } catch (notifyErr) {
        console.log('[code request notify]', notifyErr.message);
      }
    }

    res.json(result);
  } catch (err) {
    console.error('[referrals rejectCodeRequest]', err);
    res.json({ success: false, message: 'Server error. Please try again.' });
  }
}];
