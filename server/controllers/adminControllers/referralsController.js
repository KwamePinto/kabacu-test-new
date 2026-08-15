const ReferralSettings = require('../../models/ReferralSettingsModel');
const Referral         = require('../../models/ReferralModel');
const Product          = require('../../models/ProductsModal');
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

    res.render('adminview/referrals', {
      layout: 'layouts/adminLayout',
      settings,
      dataProducts,
      referrals,
      stats,
      csrfToken: res.locals.csrfToken,
    });
  } catch (err) {
    console.error('[referrals viewPanel]', err);
    res.render('adminview/referrals', {
      layout: 'layouts/adminLayout',
      settings: { rewardType: 'rewardpoint', amount: 0, isActive: true, minPurchaseAmount: 0, maxRewardsPerReferrer: 0, dataProduct: null },
      dataProducts: [], referrals: [],
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
