const ReferralSettings = require('../../models/ReferralSettingsModel');
const Referral         = require('../../models/ReferralModel');
const Product          = require('../../models/ProductsModal');
const SpecialCode = require('../../models/SpecialReferralCodeModel');
const User = require('../../models/UserModel');
const referralService = require('../../services/referralService');
const { authenticateAdminUser } = require('../../config/authMiddleware');

exports.viewPanel = [authenticateAdminUser, async (req, res) => {
  try {
    const settings = await ReferralSettings.getSettings();

    // The data reward has to name a real package, so the admin picks one from
    // the live product table rather than typing a number.
    const [dataProducts, referrals, counts] = await Promise.all([
      Product.find({ category: 'DATA' }).sort({ createdAt: -1 }).lean(),
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

    // Premium / vanity codes held for sale. Admin-only for now.
    const specialCodes = await SpecialCode.find()
      .sort({ createdAt: -1 })
      .populate('permittedUser', 'username email')
      .lean();

    res.render('adminview/referrals', {
      layout: 'layouts/adminLayout',
      settings,
      dataProducts,
      referrals,
      stats,
      specialCodes,
      csrfToken: res.locals.csrfToken,
    });
  } catch (err) {
    console.error('[referrals viewPanel]', err);
    res.render('adminview/referrals', {
      layout: 'layouts/adminLayout',
      settings: { rewardType: 'rewardpoint', amount: 0, isActive: true, minPurchaseAmount: 0, maxRewardsPerReferrer: 0, dataProduct: null },
      dataProducts: [], referrals: [], specialCodes: [],
      stats: { pending: 0, qualified: 0, rewarded: 0, void: 0 },
      csrfToken: res.locals.csrfToken,
    });
  }
}];

exports.saveSettings = [authenticateAdminUser, async (req, res) => {
  try {
    const { rewardType, amount, dataProduct, minPurchaseAmount, maxRewardsPerReferrer, isActive } = req.body;

    if (!['money', 'data', 'rewardpoint'].includes(rewardType)) {
      return res.json({ success: false, message: 'Pick a valid reward type.' });
    }

    const update = {
      rewardType,
      isActive: isActive !== false && isActive !== 'false',
      minPurchaseAmount: Math.max(0, Number(minPurchaseAmount) || 0),
      maxRewardsPerReferrer: Math.max(0, Number(maxRewardsPerReferrer) || 0),
    };

    // ── Signup bonus promotion ──────────────────────────────────────────
    // Data is not offered: a bundle needs a destination phone number a
    // brand-new account has not supplied.
    const sbType = ['money', 'rewardpoint'].includes(req.body.signupBonusType)
      ? req.body.signupBonusType : 'rewardpoint';
    const sbActive = req.body.signupBonusActive === true || req.body.signupBonusActive === 'true';
    const sbAmount = Math.max(0, Number(req.body.signupBonusAmount) || 0);

    if (sbActive && !(sbAmount > 0)) {
      return res.json({ success: false, message: 'Set a signup bonus amount above zero, or switch the promotion off.' });
    }

    update.signupBonus = { isActive: sbActive, rewardType: sbType, amount: sbAmount };

    // ── Ongoing referral commission ─────────────────────────────────────
    const rcType = ['cashback', 'rewardpoint'].includes(req.body.commissionType)
      ? req.body.commissionType : 'cashback';
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

    if (rewardType === 'data') {
      if (!dataProduct) {
        return res.json({ success: false, message: 'Choose the data package to award.' });
      }
      const exists = await Product.exists({ _id: dataProduct, category: 'DATA' });
      if (!exists) {
        return res.json({ success: false, message: 'That data package no longer exists.' });
      }
      update.dataProduct = dataProduct;
      update.amount = 0;
    } else {
      const amt = Number(amount);
      if (!(amt > 0)) {
        return res.json({ success: false, message: 'Enter a reward amount greater than zero.' });
      }
      update.amount = amt;
      update.dataProduct = null;
    }

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
    const code  = String(req.body.code || '').trim().toUpperCase();
    const price = Math.max(0, Number(req.body.price) || 0);
    const note  = String(req.body.note || '').trim();

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
      code, price, note,
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
