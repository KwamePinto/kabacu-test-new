const { allCountries, toCode, toName, toFlag, currencyFor, CURRENCIES, DEFAULT_COUNTRY } = require('../../utils/country');
const { balancePath } = require('../../utils/wallet');
const adminLayouts = "layouts/adminLayout";

const Transaction = require("../../models/TransactionModel");
const TopUp = require("../../models/TopUpModal");
const Category = require("../../models/CategoryModal");
const Product = require("../../models/ProductsModal");
const User = require("../../models/UserModel");
const Wallet = require("../../models/WalletModal");
const PaymentMethod = require("../../models/PaymentMethodModel");
const CountryWallet = require("../../models/CountryWalletModel");
const marketService = require("../../services/marketService");
const walletUtil = require("../../utils/wallet");
const Network       = require("../../models/NetworkModel");
const Referral        = require("../../models/ReferralModel");
const ReferralSettings = require("../../models/ReferralSettingsModel");
const referralService = require("../../services/referralService");

const { authenticateAdminUser } = require("../../config/authMiddleware");
const { notify } = require("../../services/userNotificationService");

exports.createProducts = [
  authenticateAdminUser,
  async (req, res) => {
    try {
      const [category, networks] = await Promise.all([
        Category.find({ is_deleted: { $ne: 1 } }).sort({ category_name: 1 }),
        Network.find({ is_deleted: { $ne: 1 } }).sort({ apiCode: 1, name: 1 }),
      ]);
      res.render("adminview/forms/add-products", {
        layout: adminLayouts,
        category,
        networks,
        countryList: allCountries(),
        query: req.query,
      });
    } catch (error) {
      console.log(error);
    }
  },
];

exports.addProduct = [
  authenticateAdminUser,
  async (req, res) => {
    try {
      const { category, reward_point, description, costPrice } = req.body;
      const baseUrl = (process.env.SERVER_BASE_URL || "").replace(/\/$/, "");
      const imagePaths = (req.files || []).map(
        (file) => baseUrl + "/uploads/" + file.filename,
      );

      let productData = {
        category,
        reward_point,
        description,
        costPrice: costPrice ? Number(costPrice) : 0,
        images: imagePaths,
        // Market this product belongs to. Falls back to NG so a product can
        // never end up untargeted and invisible to everyone.
        country: toCode(req.body.country) || DEFAULT_COUNTRY,
      };

      const validCategories = ["DATA", "ELECTRONICS", "AUTOMOBILE"];
      if (!validCategories.includes(category)) {
        return res.status(400).send("Invalid or unsupported category.");
      }

      if (category === "DATA") {
        // plan_id MUST stay per-product. It identifies the exact bundle at the
        // provider (sent as `data_plan` on purchase), and every size under a
        // plan has its own: "CTC Monthly Special-MTN" alone spans 244, 243, 4,
        // 3, 2 and 240 for 15GB/10GB/5GB/3GB/2GB/1GB. Inheriting one id from
        // the plan record would deliver the same bundle for every size.
        productData.dataDetails = {
          plan_id: req.body.plan_id,
          network: req.body.network,
          plan_type: req.body.plan_type,
          // plan_name is kept in step with plan_type: the card now leads with
          // plan_type, but older records and search still read plan_name.
          plan_name: req.body.plan_type,
          amount: req.body.amount,
          oldPrice: req.body.oldPrice,
          validate_period: req.body.validate_period,
          bonus: (req.body.bonus || "").trim(),
        };
      } else if (category === "ELECTRONICS") {
        productData.electronicDetails = {
          itemName: req.body.itemName,
          brandItem: req.body.brandItem,
          itemtype: req.body.itemtype,
          items_price: req.body.items_price,
        };
      } else if (category === "AUTOMOBILE") {
        productData.automobileDetails = {
          brand: req.body.brand,
          model: req.body.model,
          year: req.body.year,
          fuel_type: req.body.fuel_type,
          transmission: req.body.transmission,
          condition: req.body.condition,
          price: req.body.auto_price,
        };
      }

      await Product.create(productData);
      res.redirect("/admin/product/view-products?added=1");
    } catch (error) {
      console.log(error);
      res.send("Error adding product");
    }
  },
];

exports.viewProducts = [
  authenticateAdminUser,
  async (req, res) => {
    try {
      let products = await Product.find({ is_deleted: { $ne: 1 } }).sort({
        createdAt: -1,
      });

      products = products.map((p) => {
        let name = "Unknown Product";
        let price = 0;
        let extra = "";

        switch (p.category) {
          case "DATA":
            name = `${p.dataDetails?.plan_type || ""} (${p.dataDetails?.plan_name || ""})`;
            price = p.dataDetails?.amount || 0;
            extra = p.dataDetails?.network || "";
            break;
          case "AUTOMOBILE":
            name = `${p.automobileDetails?.brand || ""} ${p.automobileDetails?.model || ""}`;
            price = p.automobileDetails?.price || 0;
            extra = `${p.automobileDetails?.fuel_type || ""} | ${p.automobileDetails?.condition || ""}`;
            break;
          case "ELECTRONICS":
            name = `${p.electronicDetails?.itemName || ""}`;
            price = p.electronicDetails?.items_price || 0;
            extra = `${p.electronicDetails?.brandItem || ""} | ${p.electronicDetails?.itemtype || ""}`;
            break;
          default:
            name = "Unknown Category";
        }

        return {
          ...p._doc,
          productName: name,
          productPrice: price,
          productExtra: extra,
        };
      });

      res.render("adminview/tables/view-products", {
        products,
        layout: adminLayouts,
        query: req.query,
      });
    } catch (error) {
      console.log(error);
    }
  },
];

exports.deleteProduct = [
  authenticateAdminUser,
  async (req, res) => {
    try {
      const product = await Product.findByIdAndUpdate(
        req.params.id,
        { is_deleted: 1 },
        { new: true },
      );
      if (!product)
        return res.json({ success: false, error: "Product not found." });
      res.json({ success: true });
    } catch (error) {
      console.log(error);
      res.json({ success: false, error: error.message });
    }
  },
];

exports.toggleProduct = [
  authenticateAdminUser,
  async (req, res) => {
    try {
      const product = await Product.findById(req.params.id);
      if (!product) return res.json({ success: false, error: "Product not found." });
      product.isActive = !product.isActive;
      await product.save();
      res.json({ success: true, isActive: product.isActive });
    } catch (error) {
      console.log(error);
      res.json({ success: false, error: error.message });
    }
  },
];

exports.editProductGet = [
  authenticateAdminUser,
  async (req, res) => {
    try {
      const product = await Product.findById(req.params.id);
      if (!product) return res.redirect("/admin/product/view-products");
      const [category, networks] = await Promise.all([
        Category.find({ is_deleted: { $ne: 1 } }).sort({ category_name: 1 }),
        Network.find({ is_deleted: { $ne: 1 } }).sort({ apiCode: 1, name: 1 }),
      ]);
      res.render("adminview/forms/edit-product", {
        layout: adminLayouts,
        product,
        category,
        networks,
        countryList: allCountries(),
        query: req.query,
      });
    } catch (error) {
      console.log(error);
      res.redirect("/admin/product/view-products");
    }
  },
];

exports.editProductPost = [
  authenticateAdminUser,
  async (req, res) => {
    try {
      const product = await Product.findById(req.params.id);
      if (!product) return res.redirect("/admin/product/view-products");

      const { reward_point, description, costPrice } = req.body;
      const update = {
        reward_point:
          reward_point !== undefined ? reward_point : product.reward_point,
        description: description || product.description,
        costPrice: costPrice !== undefined ? Number(costPrice) : product.costPrice,
        country: toCode(req.body.country) || product.country || DEFAULT_COUNTRY,
      };

      // Replace images only when the admin explicitly uploaded new ones
      if (req.files && req.files.length > 0) {
        const baseUrl = (process.env.SERVER_BASE_URL || "").replace(/\/$/, "");
        update.images = req.files.map(
          (file) => baseUrl + "/uploads/" + file.filename,
        );
      }

      if (product.category === "DATA") {
        // Spread the existing subdocument first. Assigning a fresh object here
        // replaces the whole of dataDetails, so any field the form does not
        // post is erased — that is how `bonus` used to be wiped on every edit.
        // Spreading means a field added to the model later survives an edit
        // even before the form learns about it.
        const existing = product.dataDetails
          ? (typeof product.dataDetails.toObject === "function"
              ? product.dataDetails.toObject()
              : { ...product.dataDetails })
          : {};

        update.dataDetails = {
          ...existing,
          plan_id: req.body.plan_id ?? existing.plan_id,
          network: req.body.network || existing.network,
          plan_type: req.body.plan_type || existing.plan_type,
          plan_name: req.body.plan_name || req.body.plan_type || existing.plan_name,
          amount: req.body.amount ?? existing.amount,
          oldPrice: req.body.oldPrice ?? existing.oldPrice,
          validate_period: req.body.validate_period || existing.validate_period,
          // Bonus is the one text field an admin must be able to CLEAR, so it
          // reads the posted value whenever the field was submitted at all —
          // `|| existing` would make an emptied box impossible to save.
          bonus:
            req.body.bonus !== undefined
              ? String(req.body.bonus).trim()
              : existing.bonus,
        };
      } else if (product.category === "ELECTRONICS") {
        update.electronicDetails = {
          itemName: req.body.itemName || product.electronicDetails?.itemName,
          brandItem: req.body.brandItem || product.electronicDetails?.brandItem,
          itemtype: req.body.itemtype || product.electronicDetails?.itemtype,
          items_price:
            req.body.items_price ?? product.electronicDetails?.items_price,
        };
      } else if (product.category === "AUTOMOBILE") {
        update.automobileDetails = {
          brand: req.body.brand || product.automobileDetails?.brand,
          model: req.body.model || product.automobileDetails?.model,
          year: req.body.year ?? product.automobileDetails?.year,
          fuel_type: req.body.fuel_type || product.automobileDetails?.fuel_type,
          transmission:
            req.body.transmission || product.automobileDetails?.transmission,
          condition: req.body.condition || product.automobileDetails?.condition,
          price: req.body.auto_price ?? product.automobileDetails?.price,
        };
      }

      await Product.findByIdAndUpdate(req.params.id, update);
      res.redirect("/admin/product/view-products?updated=1");
    } catch (error) {
      console.log(error);
      res.redirect("/admin/product/edit-product/" + req.params.id + "?error=1");
    }
  },
];

exports.userView = [
  authenticateAdminUser,
  async (req, res) => {
    try {
      const [total, verified, unverified, withMinerId] = await Promise.all([
        User.countDocuments(),
        User.countDocuments({ isVerified: true }),
        User.countDocuments({ isVerified: false }),
        User.countDocuments({ minerId: { $exists: true, $ne: null } }),
      ]);
      res.render("adminview/tables/view-users", {
        stats: { total, verified, unverified, withMinerId },
        layout: adminLayouts,
      });
    } catch (err) {
      console.error(err);
      res.status(500).send("Server Error");
    }
  },
];

exports.getUsersData = [
  authenticateAdminUser,
  async (req, res) => {
    try {
      const draw   = parseInt(req.query.draw) || 1;
      const start  = parseInt(req.query.start) || 0;
      const length = Math.min(parseInt(req.query.length) || 25, 500);
      const search = (req.query['search[value]'] ?? req.query.search?.value)?.trim() || '';

      const SORT_COLS = { 1: 'username', 2: 'phone_number', 3: 'country', 7: 'createdAt' };
      const orderColIdx = parseInt(req.query['order[0][column]'] ?? req.query.order?.[0]?.column) || 7;
      const orderDir = (req.query['order[0][dir]'] ?? req.query.order?.[0]?.dir) === 'asc' ? 1 : -1;
      const sortField = SORT_COLS[orderColIdx] || 'createdAt';

      let filter = {};
      if (search) {
        // Escape regex special characters so e.g. "+" in phone numbers doesn't throw
        const safeSearch = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        filter = {
          $or: [
            { username:     { $regex: safeSearch, $options: 'i' } },
            { email:        { $regex: safeSearch, $options: 'i' } },
            { firstname:    { $regex: safeSearch, $options: 'i' } },
            { lastname:     { $regex: safeSearch, $options: 'i' } },
            { phone_number: { $regex: safeSearch, $options: 'i' } },
          ],
        };
      }

      const [totalCount, filteredCount, users] = await Promise.all([
        User.countDocuments(),
        User.countDocuments(filter),
        User.find(filter)
          .select('username email firstname lastname createdAt isVerified country phone_number minerId')
          .sort({ [sortField]: orderDir })
          .skip(start)
          .limit(length)
          .lean(),
      ]);

      const data = users.map((u, i) => ({
        rowNum:     start + i + 1,
        id:         u._id,
        username:   u.username || '—',
        email:      u.email || '—',
        phone:      u.phone_number || '—',
        country:    u.country || '—',
        minerId:    u.minerId || null,
        isVerified: u.isVerified,
        createdAt:  new Date(u.createdAt || parseInt(u._id.toString().substring(0, 8), 16) * 1000).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
      }));

      res.json({ draw, recordsTotal: totalCount, recordsFiltered: filteredCount, data });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  },
];

exports.userDetails = [
  authenticateAdminUser,
  async (req, res) => {
    try {
      const user = await User.findById(req.params.id);
      if (!user) return res.redirect("/admin/product/view-users");

      const [wallet, transactions, topups, referralsMade, referredBy, referralSettings] =
        await Promise.all([
          Wallet.findOne({ user: user._id }).lean(),
          Transaction.find({ user: user._id })
            .populate("product", "item_name category dataDetails costPrice")
            .populate("products.product", "item_name category")
            .sort({ createdAt: -1 })
            .limit(200)
            .lean(),
          TopUp.find({ user: user._id }).sort({ createdAt: -1 }).limit(100).lean(),

          // Everyone this user brought in, with the reward each one produced
          Referral.find({ referrer: user._id })
            .sort({ createdAt: -1 })
            .populate("referred", "username email phone_number referralCode")
            .populate("rewardProduct", "dataDetails")
            .lean(),

          // Who brought this user in
          Referral.findOne({ referred: user._id })
            .populate("referrer", "username email phone_number referralCode")
            .populate("rewardProduct", "dataDetails")
            .lean(),

          ReferralSettings.getSettings(),
        ]);

      // Existing accounts were backfilled, but generate on demand so the page
      // never shows a blank code.
      const referralCode = user.referralCode || await referralService.ensureReferralCode(user._id);

      // Split by whether the reward has actually been paid. `qualified` means
      // the threshold was met but payout has not completed, so it is still owed.
      const referralStats = {
        total:     referralsMade.length,
        rewarded:  referralsMade.filter(r => r.status === 'rewarded').length,
        pending:   referralsMade.filter(r => r.status === 'pending' || r.status === 'qualified').length,
        voided:    referralsMade.filter(r => r.status === 'void').length,
        earnedRp:    referralsMade.filter(r => r.status === 'rewarded' && r.rewardType === 'rewardpoint')
                                  .reduce((s, r) => s + (r.rewardAmount || 0), 0),
        earnedMoney: referralsMade.filter(r => r.status === 'rewarded' && r.rewardType === 'money')
                                  .reduce((s, r) => s + (r.rewardAmount || 0), 0),
        earnedData:  referralsMade.filter(r => r.status === 'rewarded' && r.rewardType === 'data').length,
        commissionEarned: referralsMade.reduce((s, r) => s + (r.commissionEarned || 0), 0),
        commissionCount:  referralsMade.reduce((s, r) => s + (r.commissionCount || 0), 0),
      };

      const walletBalances = wallet?.balances || {
        BTT: 0,
        RP: 0,
        USDT: 0,
        NAIRA: 0,
      };

      const totalSpent = transactions
        .filter((tx) => tx.status === "success")
        .reduce((sum, tx) => sum + (tx.amount || 0), 0);

      const totalToppedUp = topups
        .filter((tp) => tp.status === "COMPLETED")
        .reduce((sum, tp) => sum + (tp.nairaAmount || tp.amount || 0), 0);

      const successfulTransactions = transactions.filter(
        (tx) => tx.status === "success"
      ).length;
      const failedTransactions = transactions.filter(
        (tx) => tx.status === "failed"
      ).length;

      // Build unified account statements (all money movements sorted by date)
      const accountStatements = [
        ...transactions.map(tx => {
          const ar = tx.apiResponse || {};
          let entryType = 'payment';
          if (tx.paymentMethod === 'Admin') {
            if (ar.adminRefund) entryType = 'refund';
            else if (ar.adminDeducted) entryType = 'deduction';
            else entryType = 'credit';
          } else if (tx.reference && /^ADMIN-REFUND/.test(tx.reference)) {
            entryType = 'refund';
          } else if (tx.reference && /^ADMIN-/.test(tx.reference)) {
            entryType = 'credit';
          } else if (tx.status === 'refunded') {
            entryType = 'system-refund';
          }
          const balBefore = tx.balanceBefore != null ? tx.balanceBefore
                          : (ar.balanceBefore != null ? ar.balanceBefore : null);
          const balAfter  = tx.balanceAfter  != null ? tx.balanceAfter
                          : (ar.balanceAfter  != null ? ar.balanceAfter
                          : (ar.refundBalAfter != null ? ar.refundBalAfter : null));
          let description = '';
          if (entryType === 'deduction') description = ar.adminDeductReason || '';
          else if (entryType === 'refund' || entryType === 'credit') description = ar.refundReason || ar.adminDeductReason || '';
          if (!description) {
            if (tx.product) {
              description = tx.product.item_name || (tx.product.dataDetails && tx.product.dataDetails.plan_name) || '';
            } else if (tx.products && tx.products.length) {
              description = tx.products.filter(p => p.product)
                .map(p => p.product.item_name || (p.product.dataDetails && p.product.dataDetails.plan_name) || '')
                .filter(Boolean).join(', ');
            }
          }
          return {
            _source: 'transaction', _entryType: entryType,
            _id: tx._id, reference: tx.reference || '',
            description: description || '—',
            amount: tx.amount || 0, walletType: tx.walletType || 'NAIRA',
            balanceBefore: balBefore, balanceAfter: balAfter,
            status: tx.status, createdAt: tx.createdAt,
            rpEarned: tx.rpEarned || 0, paymentMethod: tx.paymentMethod || '',
            phone: tx.phone || '',
            performedBy: ar.adminDeductedBy || ar.refundApprovedBy || ar.refundBy || '',
            _refundOf: ar.adminRefundOf || '', _originalRef: ar.originalRef || '',
          };
        }),
        ...topups.map(tp => {
          const pmDisplay = tp.balanceType && ['RP','BTT','USDT'].includes(tp.balanceType) ? 'Bittoken' : (tp.paymentMethod || 'External');
          return {
            _source: 'topup', _entryType: 'topup',
            _id: tp._id, reference: tp.reference || '',
            description: (tp.balanceType || 'NAIRA') + ' wallet top-up',
            amount: tp.nairaAmount || tp.amount || 0, walletType: tp.balanceType || 'NAIRA',
            balanceBefore: null, balanceAfter: null,
            status: tp.status === 'COMPLETED' ? 'success' : (tp.status ? tp.status.toLowerCase() : 'pending'),
            createdAt: tp.createdAt, rpEarned: 0,
            paymentMethod: pmDisplay, phone: '', performedBy: pmDisplay,
            _refundOf: '', _originalRef: '',
            _topupWalletCredited: tp.walletCredited, _topupBalanceType: tp.balanceType,
          };
        }),
      ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

      res.render("adminview/tables/user-details", {
        referralCode,
        referralsMade,
        referredBy,
        referralSettings,
        referralStats,
        layout: adminLayouts,
        user,
        walletBalances,
        transactions,
        topups,
        accountStatements,
        totalSpent,
        totalToppedUp,
        successfulTransactions,
        failedTransactions,
      });
    } catch (err) {
      console.log("USER DETAILS ERROR:", err);
      res.redirect("/admin/product/view-users");
    }
  },
];

exports.productDetails = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    res.json(product);
  } catch (err) {
    res.status(500).json({ error: "Product not found" });
  }
};

exports.viewTransactions = [
  authenticateAdminUser,
  async (req, res) => {
    try {
      const transactions = await Transaction.find()
        .populate("user", "username email firstname")
        .populate("product", "item_name category dataDetails costPrice")
        .populate("products.product", "item_name category")
        .sort({ createdAt: -1 })
        .limit(1000)
        .lean();
      res.render("adminview/tables/transactions", {
        layout: adminLayouts,
        transactions,
      });
    } catch (err) {
      console.log(err);
    }
  },
];

exports.viewTopUps = [
  authenticateAdminUser,
  async (req, res) => {
    try {
      const topups = await TopUp.find()
        .populate("user", "username email")
        .sort({ createdAt: -1 })
        .limit(1000)
        .lean();
      res.render("adminview/tables/topUps", { layout: adminLayouts, topups });
    } catch (err) {
      console.log(err);
    }
  },
];

exports.viewPaymentMethods = [
  authenticateAdminUser,
  async (req, res) => {
    try {
      const [countryWallets, methods] = await Promise.all([
        CountryWallet.find().sort({ country: 1 }).lean(),
        PaymentMethod.find().sort({ country: 1, createdAt: -1 }).lean(),
      ]);

      // Group the methods under their market so the view renders one card per
      // country instead of a flat list an admin has to read country codes off.
      const byCountry = {};
      methods.forEach((m) => {
        const c = toCode(m.country) || DEFAULT_COUNTRY;
        (byCountry[c] = byCountry[c] || []).push(m);
      });

      // How many products each market has. A market with products but no wallet
      // can be browsed and not bought from, which is worth flagging to the
      // admin rather than leaving them to discover it from a support ticket.
      const productCounts = await Product.aggregate([
        { $match: { is_deleted: { $ne: 1 } } },
        { $group: { _id: "$country", n: { $sum: 1 } } },
      ]);
      const productsPer = {};
      productCounts.forEach((r) => {
        productsPer[toCode(r._id) || DEFAULT_COUNTRY] = r.n;
      });

      const wallets = countryWallets.map((cw) => ({
        ...cw,
        name: toName(cw.country),
        flag: toFlag(cw.country),
        methods: byCountry[cw.country] || [],
        productCount: productsPer[cw.country] || 0,
      }));

      // Markets holding products but with no wallet — browsable, not buyable.
      const walletCodes = new Set(countryWallets.map((c) => c.country));
      const unwalleted = Object.keys(productsPer)
        .filter((c) => !walletCodes.has(c))
        .map((c) => ({ code: c, name: toName(c), flag: toFlag(c), productCount: productsPer[c] }));

      // Methods whose country has no wallet at all. These are invisible to
      // users, so surface them rather than letting them look configured.
      const orphanMethods = methods.filter((m) => !walletCodes.has(toCode(m.country) || DEFAULT_COUNTRY));

      res.render("adminview/payments-wallets", {
        layout: adminLayouts,
        wallets,
        unwalleted,
        orphanMethods,
        // Only countries that do not already have a wallet can be added.
        addableCountries: allCountries().filter((c) => !walletCodes.has(c.code)),
        currencies: CURRENCIES,
        // Kept for any bookmarked link or partial still expecting the flat list.
        methods,
      });
    } catch (err) {
      console.log(err);
      res.redirect("/admin/dashboard");
    }
  },
];

/* ── Country wallets ────────────────────────────────────────────────────────
   Adding one of these is what makes a market live: users get a balance in that
   currency, the country appears in their wallet switcher, and the methods
   registered against it become their funding options.                       */

exports.addCountryWallet = [
  authenticateAdminUser,
  async (req, res) => {
    const back = "/admin/payments-wallets";
    try {
      const code = toCode(req.body.country);
      if (!code) {
        req.flash("error", "Pick a country from the list.");
        return res.redirect(back);
      }

      const exists = await CountryWallet.findOne({ country: code });
      if (exists) {
        req.flash("error", `${toName(code)} already has a wallet.`);
        return res.redirect(back);
      }

      // Currency is frozen onto the record now rather than looked up on read,
      // so a wallet holding money keeps the currency it was created with. The
      // admin can override it for a market the lookup table does not cover.
      const fallback = currencyFor(code);
      const currencyCode = (req.body.currencyCode || fallback.code || "").trim().toUpperCase();
      const currencySymbol = (req.body.currencySymbol || fallback.symbol || code).trim();
      const currencyName = (req.body.currencyName || fallback.name || "").trim();

      if (!currencySymbol) {
        req.flash("error", "This market needs a currency symbol.");
        return res.redirect(back);
      }

      await CountryWallet.create({
        country: code,
        currencyCode,
        currencySymbol,
        currencyName,
        isActive: true,
        createdBy: (req.user && req.user.username) || "admin",
      });
      marketService.invalidate();

      // Payment methods can be entered on the same form. They are what makes
      // the wallet fundable, so a wallet created without any is announced as
      // such rather than silently offering users nothing to pay with.
      const names = [].concat(req.body.methodName || []).filter((n) => String(n).trim());
      const descs = [].concat(req.body.methodDescription || []);
      const instrs = [].concat(req.body.methodInstructions || []);

      if (names.length) {
        await PaymentMethod.insertMany(
          names.map((n, i) => ({
            name: String(n).trim(),
            description: String(descs[i] || "").trim(),
            instructions: String(instrs[i] || "").trim(),
            country: code,
            // A new market has no gateway integration, so funding starts manual
            // and an admin confirms each top-up. Nigeria/PalmPay is the only
            // gateway wired up, and it is seeded, not created here.
            kind: "manual",
            isActive: true,
          })),
        );
        req.flash("success", `${toName(code)} wallet created with ${names.length} payment method(s).`);
      } else {
        req.flash(
          "success",
          `${toName(code)} wallet created. Add a payment method before users can fund it.`,
        );
      }

      res.redirect(back);
    } catch (err) {
      console.log(err);
      req.flash("error", "Could not create that wallet.");
      res.redirect(back);
    }
  },
];

exports.editCountryWallet = [
  authenticateAdminUser,
  async (req, res) => {
    const back = "/admin/payments-wallets";
    try {
      const wallet = await CountryWallet.findById(req.params.id);
      if (!wallet) {
        req.flash("error", "Wallet not found.");
        return res.redirect(back);
      }

      // The country itself is deliberately not editable. Balances are keyed by
      // it, so repointing a wallet at another market would silently reassign
      // every user's money.
      if (req.body.currencyCode !== undefined) {
        wallet.currencyCode = String(req.body.currencyCode).trim().toUpperCase();
      }
      if (req.body.currencySymbol !== undefined && String(req.body.currencySymbol).trim()) {
        wallet.currencySymbol = String(req.body.currencySymbol).trim();
      }
      if (req.body.currencyName !== undefined) {
        wallet.currencyName = String(req.body.currencyName).trim();
      }

      await wallet.save();
      marketService.invalidate();
      req.flash("success", `${toName(wallet.country)} wallet updated.`);
      res.redirect(back);
    } catch (err) {
      console.log(err);
      req.flash("error", "Could not update that wallet.");
      res.redirect(back);
    }
  },
];

exports.toggleCountryWallet = [
  authenticateAdminUser,
  async (req, res) => {
    const back = "/admin/payments-wallets";
    try {
      const wallet = await CountryWallet.findById(req.params.id);
      if (!wallet) return res.redirect(back);

      // Nigeria is the fallback every other market falls back TO — a user on a
      // country with no wallet lands on Naira. Switching it off would leave
      // them with nowhere to go, so it stays on.
      if (wallet.country === DEFAULT_COUNTRY && wallet.isActive) {
        req.flash("error", "Nigeria is the fallback market and cannot be switched off.");
        return res.redirect(back);
      }

      wallet.isActive = !wallet.isActive;
      await wallet.save();
      marketService.invalidate();
      req.flash(
        "success",
        `${toName(wallet.country)} is now ${wallet.isActive ? "live" : "hidden from users"}.`,
      );
      res.redirect(back);
    } catch (err) {
      console.log(err);
      res.redirect(back);
    }
  },
];

exports.deleteCountryWallet = [
  authenticateAdminUser,
  async (req, res) => {
    const back = "/admin/payments-wallets";
    try {
      const wallet = await CountryWallet.findById(req.params.id);
      if (!wallet) return res.redirect(back);

      if (wallet.country === DEFAULT_COUNTRY) {
        req.flash("error", "The Nigeria wallet cannot be deleted.");
        return res.redirect(back);
      }

      /* Refuse while users still hold money in it. Deleting the wallet does not
         delete the balances, so this would orphan real money behind a market
         the switcher no longer lists. Deactivating is the reversible way out.

         The $exists is load-bearing. `{ $ne: 0 }` alone also matches documents
         where the field is ABSENT — and countryBalances.XX is absent until the
         first time money moves in that market, so every wallet in the system
         matched and a brand-new market could never be deleted. Nigeria hid this
         because balances.NAIRA has a schema default and is therefore always
         present.

         $nin catches negatives too: a user with a negative balance owes money,
         which is a stronger reason to refuse, not a weaker one. */
      const path = balancePath(wallet.country);
      const holders = await Wallet.countDocuments({
        [path]: { $exists: true, $nin: [0, null] },
      });

      if (holders > 0) {
        req.flash(
          "error",
          `Cannot remove ${toName(wallet.country)}: ${holders} user(s) still hold ` +
          `${wallet.currencyName || wallet.currencyCode || wallet.country} funds. ` +
          `Hide the market instead — that stops users seeing it without touching their money.`,
        );
        return res.redirect(back);
      }

      await PaymentMethod.deleteMany({ country: wallet.country });
      await CountryWallet.findByIdAndDelete(req.params.id);
      marketService.invalidate();
      req.flash("success", `${toName(wallet.country)} wallet removed.`);
      res.redirect(back);
    } catch (err) {
      console.log(err);
      req.flash("error", "Could not remove that wallet.");
      res.redirect(back);
    }
  },
];

/* ── Payment methods ───────────────────────────────────────────────────────
   Scoped to a market. Names are unique per country, not globally: "Bank
   transfer" is a legitimate method in Ghana and in Nigeria at the same time,
   and the old global check would have rejected the second one.              */

exports.addPaymentMethod = [
  authenticateAdminUser,
  async (req, res) => {
    const back = "/admin/payments-wallets";
    try {
      const { name, description, instructions } = req.body;
      const code = toCode(req.body.country) || DEFAULT_COUNTRY;

      if (!name || !name.trim()) {
        req.flash("error", "Payment method name is required");
        return res.redirect(back);
      }

      // A method for a market with no wallet would never be shown to anyone.
      const wallet = await CountryWallet.findOne({ country: code });
      if (!wallet) {
        req.flash("error", `Create the ${toName(code)} wallet before adding methods for it.`);
        return res.redirect(back);
      }

      const exists = await PaymentMethod.findOne({ name: name.trim(), country: code });
      if (exists) {
        req.flash("error", `${toName(code)} already has a method called "${name.trim()}".`);
        return res.redirect(back);
      }

      await PaymentMethod.create({
        name: name.trim(),
        description: (description || "").trim(),
        instructions: (instructions || "").trim(),
        country: code,
        kind: req.body.kind === "gateway" ? "gateway" : "manual",
        provider: (req.body.provider || "").trim(),
      });

      req.flash("success", `Method added to ${toName(code)}.`);
      res.redirect(back);
    } catch (err) {
      console.log(err);
      req.flash("error", "Something went wrong");
      res.redirect(back);
    }
  },
];

exports.editPaymentMethod = [
  authenticateAdminUser,
  async (req, res) => {
    const back = "/admin/payments-wallets";
    try {
      const method = await PaymentMethod.findById(req.params.id);
      if (!method) {
        req.flash("error", "Payment method not found");
        return res.redirect(back);
      }

      const { name, description, instructions } = req.body;
      if (!name || !name.trim()) {
        req.flash("error", "Payment method name is required");
        return res.redirect(back);
      }

      // Uniqueness is checked within the method's own market.
      const clash = await PaymentMethod.findOne({
        name: name.trim(),
        country: method.country,
        _id: { $ne: req.params.id },
      });
      if (clash) {
        req.flash("error", `${toName(method.country)} already has a method called "${name.trim()}".`);
        return res.redirect(back);
      }

      method.name = name.trim();
      method.description = (description || "").trim();
      if (instructions !== undefined) method.instructions = String(instructions).trim();
      // `kind` and `provider` are left alone: the Nigeria/PalmPay method is a
      // gateway and flipping it to manual from this form would break the live
      // checkout redirect.
      await method.save();

      req.flash("success", "Payment method updated");
      res.redirect(back);
    } catch (err) {
      console.log(err);
      req.flash("error", "Something went wrong");
      res.redirect(back);
    }
  },
];

exports.togglePaymentMethod = [
  authenticateAdminUser,
  async (req, res) => {
    try {
      const method = await PaymentMethod.findById(req.params.id);
      if (method) {
        method.isActive = !method.isActive;
        await method.save();
      }
      res.redirect("/admin/payments-wallets");
    } catch (err) {
      console.log(err);
      res.redirect("/admin/payments-wallets");
    }
  },
];

exports.deletePaymentMethod = [
  authenticateAdminUser,
  async (req, res) => {
    try {
      await PaymentMethod.findByIdAndDelete(req.params.id);
      req.flash("success", "Payment method deleted");
      res.redirect("/admin/payments-wallets");
    } catch (err) {
      console.log(err);
      req.flash("error", "Could not delete that payment method");
      res.redirect("/admin/payments-wallets");
    }
  },
];

/* ── Manual top-up confirmation ─────────────────────────────────────────────
   Markets with no payment gateway are funded on trust plus a check: the user
   records that they paid, an admin verifies it against the actual account, and
   only then does money appear. This is the only place a country wallet other
   than Nigeria is credited from a top-up.                                   */

exports.confirmManualTopUp = [
  authenticateAdminUser,
  async (req, res) => {
    try {
      /* Claim the row before crediting anything. The compare-and-swap on
         walletCredited is what makes a double-click — or two admins working the
         queue at once — credit the wallet once instead of twice. */
      const claimed = await TopUp.findOneAndUpdate(
        {
          _id: req.params.id,
          isManual: true,
          status: "PENDING",
          walletCredited: { $ne: true },
        },
        {
          $set: {
            walletCredited: true,
            status: "COMPLETED",
            confirmedBy: (req.user && req.user.username) || "admin",
            confirmedAt: new Date(),
          },
        },
        { new: false },
      );

      if (!claimed) {
        return res.json({
          success: false,
          message: "Already handled, or no longer pending.",
        });
      }

      const market = claimed.walletCountry || DEFAULT_COUNTRY;

      // Atomic credit, reporting the balance either side so the account
      // statement records a chain that actually joins up.
      const moved = await walletUtil.applyDelta(Wallet, claimed.user, market, claimed.amount);

      if (!moved) {
        // No wallet to credit. Put the top-up back rather than reporting a
        // success that moved nothing.
        await TopUp.findByIdAndUpdate(claimed._id, {
          $set: { walletCredited: false, status: "PENDING", confirmedBy: "", confirmedAt: null },
        });
        return res.json({ success: false, message: "That user has no wallet record." });
      }

      const cw = await CountryWallet.findOne({ country: market }).lean();
      const symbol = (cw && cw.currencySymbol) || "";

      await TopUp.findByIdAndUpdate(claimed._id, {
        $set: { balanceBefore: moved.balanceBefore, balanceAfter: moved.balanceAfter },
      });

      try {
        await notify(claimed.user, {
          type: "success",
          text:
            `Your ${(cw && cw.currencyName) || market} wallet has been credited with ` +
            `${symbol}${Number(claimed.amount).toLocaleString()}.`,
        });
      } catch (notifyErr) {
        // A missed notification must not undo a confirmed credit.
        console.log("[manual topup notify]", notifyErr.message);
      }

      res.json({
        success: true,
        message:
          `Credited ${symbol}${Number(claimed.amount).toLocaleString()}. ` +
          `Balance ${symbol}${moved.balanceBefore.toLocaleString()} → ` +
          `${symbol}${moved.balanceAfter.toLocaleString()}.`,
      });
    } catch (err) {
      console.log(err);
      res.json({ success: false, message: "Could not confirm that top-up." });
    }
  },
];

exports.rejectManualTopUp = [
  authenticateAdminUser,
  async (req, res) => {
    try {
      const reason = String(req.body.reason || "").trim();
      if (!reason) {
        return res.json({ success: false, message: "Give a reason so the user knows why." });
      }

      // Same guard as confirming: only an untouched pending row can be rejected,
      // so a top-up that was just credited cannot also be marked failed.
      const claimed = await TopUp.findOneAndUpdate(
        { _id: req.params.id, isManual: true, status: "PENDING", walletCredited: { $ne: true } },
        {
          $set: {
            status: "FAILED",
            rejectedReason: reason,
            confirmedBy: (req.user && req.user.username) || "admin",
            confirmedAt: new Date(),
          },
        },
        { new: true },
      );

      if (!claimed) {
        return res.json({ success: false, message: "Already handled, or no longer pending." });
      }

      try {
        await notify(claimed.user, {
          type: "attention",
          text: `We could not confirm your top-up of ${claimed.amount}. ${reason}`,
        });
      } catch (notifyErr) {
        console.log("[manual topup notify]", notifyErr.message);
      }

      res.json({ success: true, message: "Marked as not confirmed." });
    } catch (err) {
      console.log(err);
      res.json({ success: false, message: "Could not reject that top-up." });
    }
  },
];

exports.adminDeductWallet = [
  authenticateAdminUser,
  async (req, res) => {
    try {
      const { amount, reason } = req.body;
      const userId = req.params.id;

      const parsed = parseFloat(amount);
      if (!parsed || parsed <= 0) {
        return res.json({ success: false, message: 'Enter a valid amount greater than 0.' });
      }

      const user = await User.findById(userId);
      if (!user) return res.json({ success: false, message: 'User not found.' });

      const wallet = await Wallet.findOne({ user: userId });
      if (!wallet) return res.json({ success: false, message: 'Wallet not found for this user.' });

      const balanceBefore = wallet.balances.NAIRA;
      wallet.balances.NAIRA -= parsed;
      await wallet.save();

      const balanceAfter = wallet.balances.NAIRA;

      // Create an auditable Transaction record so this deduction can be refunded later
      await Transaction.create({
        user:          userId,
        amount:        parsed,
        walletType:    'NAIRA',
        paymentMethod: 'Admin',
        status:        'success',
        reference:     'ADMIN-DEDUCT-' + Date.now(),
        balanceBefore: balanceBefore,
        balanceAfter:  balanceAfter,
        apiResponse: {
          adminDeducted:      true,
          adminDeductedBy:    req.user?.username || 'admin',
          adminDeductedAt:    new Date().toISOString(),
          adminDeductReason:  reason || '',
          balanceBefore:      balanceBefore,
          balanceAfter:       balanceAfter,
        },
      });

      if (balanceAfter < 0) {
        notify(userId, {
          type: 'info',
          text: `Your account has a pending balance of ₦${Math.abs(balanceAfter).toLocaleString()} to be paid. This amount will be debited from your account.`,
          link: '/user/transaction-history',
        });
      }

      return res.json({
        success: true,
        message: `₦${parsed.toLocaleString()} has been deducted from ${user.username || user.email}'s wallet.`,
        balanceBefore,
        balanceAfter,
      });
    } catch (err) {
      console.log('ADMIN DEDUCT WALLET ERROR:', err);
      return res.json({ success: false, message: 'An error occurred. Please try again.' });
    }
  },
];

// Returns all unrefunded deductions for a user (for the refund modal)
exports.getAvailableRefunds = [
  authenticateAdminUser,
  async (req, res) => {
    try {
      const deductions = await Transaction.find({
        user: req.params.id,
        'apiResponse.adminDeducted': true,
        'apiResponse.adminRefunded': { $ne: true },
        'apiResponse.refundPending': { $ne: true },
      }).sort({ createdAt: -1 }).lean();

      res.json({ success: true, deductions });
    } catch (err) {
      console.error('[getAvailableRefunds]', err);
      res.json({ success: false, message: 'Failed to load deductions.' });
    }
  },
];

// Refund a specific admin deduction from the user detail page
exports.adminRefundDeduction = [
  authenticateAdminUser,
  async (req, res) => {
    try {
      const { transactionId, reason } = req.body;
      const userId = req.params.id;

      if (!transactionId) return res.json({ success: false, message: 'No deduction selected.' });
      if (!reason || !reason.trim()) return res.json({ success: false, message: 'A refund reason is required.' });

      const tx = await Transaction.findOne({
        _id: transactionId,
        user: userId,
        'apiResponse.adminDeducted': true,
        'apiResponse.adminRefunded': { $ne: true },
        'apiResponse.refundPending': { $ne: true },
      });
      if (!tx) return res.json({ success: false, message: 'Deduction not found or already refunded.' });

      const wallet = await Wallet.findOne({ user: userId });
      if (!wallet) return res.json({ success: false, message: 'User wallet not found.' });

      const balanceBefore = wallet.balances.NAIRA;
      wallet.balances.NAIRA += tx.amount;
      await wallet.save();

      tx.apiResponse.adminRefunded    = true;
      tx.apiResponse.adminRefundedAt  = new Date().toISOString();
      tx.apiResponse.refundReason     = reason.trim();
      tx.apiResponse.refundApprovedBy = req.user?.username || 'admin';
      tx.apiResponse.refundPending    = false;
      tx.apiResponse.refundBalBefore  = balanceBefore;
      tx.apiResponse.refundBalAfter   = wallet.balances.NAIRA;
      tx.markModified('apiResponse');
      await tx.save();

      // Create a separate ledger entry for the refund so it appears as its own statement row
      await Transaction.create({
        user:          userId,
        amount:        tx.amount,
        walletType:    tx.walletType || 'NAIRA',
        paymentMethod: 'Admin',
        status:        'success',
        reference:     'ADMIN-REFUND-' + Date.now(),
        balanceBefore: balanceBefore,
        balanceAfter:  wallet.balances.NAIRA,
        apiResponse: {
          adminRefund:     true,
          adminRefundOf:   tx._id.toString(),
          originalRef:     tx.reference,
          refundReason:    reason.trim(),
          refundBy:        req.user?.username || 'admin',
          adminRefundedAt: new Date().toISOString(),
          balanceBefore:   balanceBefore,
          balanceAfter:    wallet.balances.NAIRA,
        },
      });

      notify(userId, {
        type: 'success',
        text: `A refund of ₦${tx.amount.toLocaleString()} has been issued to your wallet by admin.`,
        link: '/user/transaction-history',
      });

      return res.json({
        success: true,
        message: `₦${tx.amount.toLocaleString()} refunded. New balance: ₦${wallet.balances.NAIRA.toLocaleString()}`,
      });
    } catch (err) {
      console.error('[adminRefundDeduction]', err);
      return res.json({ success: false, message: 'Server error. Please try again.' });
    }
  },
];
