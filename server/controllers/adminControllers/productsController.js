const adminLayouts = "layouts/adminLayout";

const Transaction = require("../../models/TransactionModel");
const TopUp = require("../../models/TopUpModal");
const Category = require("../../models/CategoryModal");
const Product = require("../../models/ProductsModal");
const User = require("../../models/UserModel");
const Wallet = require("../../models/WalletModal");
const PaymentMethod = require("../../models/PaymentMethodModel");
const Network       = require("../../models/NetworkModel");

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
      };

      const validCategories = ["DATA", "ELECTRONICS", "AUTOMOBILE"];
      if (!validCategories.includes(category)) {
        return res.status(400).send("Invalid or unsupported category.");
      }

      if (category === "DATA") {
        productData.dataDetails = {
          plan_id: req.body.plan_id,
          network: req.body.network,
          plan_type: req.body.plan_type,
          plan_name: req.body.plan_name,
          amount: req.body.amount,
          oldPrice: req.body.oldPrice,
          validate_period: req.body.validate_period,
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
      };

      // Replace images only when the admin explicitly uploaded new ones
      if (req.files && req.files.length > 0) {
        const baseUrl = (process.env.SERVER_BASE_URL || "").replace(/\/$/, "");
        update.images = req.files.map(
          (file) => baseUrl + "/uploads/" + file.filename,
        );
      }

      if (product.category === "DATA") {
        update.dataDetails = {
          plan_id: req.body.plan_id ?? product.dataDetails?.plan_id,
          network: req.body.network || product.dataDetails?.network,
          plan_type: req.body.plan_type || product.dataDetails?.plan_type,
          plan_name: req.body.plan_name || product.dataDetails?.plan_name,
          amount: req.body.amount ?? product.dataDetails?.amount,
          oldPrice: req.body.oldPrice ?? product.dataDetails?.oldPrice,
          validate_period:
            req.body.validate_period || product.dataDetails?.validate_period,
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

      const [wallet, transactions, topups] = await Promise.all([
        Wallet.findOne({ user: user._id }).lean(),
        Transaction.find({ user: user._id })
          .populate("product", "item_name category dataDetails costPrice")
          .populate("products.product", "item_name category")
          .sort({ createdAt: -1 })
          .limit(200)
          .lean(),
        TopUp.find({ user: user._id }).sort({ createdAt: -1 }).limit(100).lean(),
      ]);

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
      const methods = await PaymentMethod.find().sort({ createdAt: -1 });
      res.render("adminview/payment-methods", {
        layout: adminLayouts,
        methods,
      });
    } catch (err) {
      console.log(err);
    }
  },
];

exports.addPaymentMethod = [
  authenticateAdminUser,
  async (req, res) => {
    try {
      const { name, description } = req.body;
      if (!name || !name.trim()) {
        req.flash("error", "Payment method name is required");
        return res.redirect("/admin/product/payment-methods");
      }
      const exists = await PaymentMethod.findOne({ name: name.trim() });
      if (exists) {
        req.flash("error", "A payment method with that name already exists");
        return res.redirect("/admin/product/payment-methods");
      }
      await PaymentMethod.create({ name: name.trim(), description: (description || '').trim() });
      req.flash("success", "Payment method added");
      res.redirect("/admin/product/payment-methods");
    } catch (err) {
      console.log(err);
      req.flash("error", "Something went wrong");
      res.redirect("/admin/product/payment-methods");
    }
  },
];

exports.editPaymentMethod = [
  authenticateAdminUser,
  async (req, res) => {
    try {
      const { name, description } = req.body;
      if (!name || !name.trim()) {
        req.flash("error", "Payment method name is required");
        return res.redirect("/admin/product/payment-methods");
      }
      const exists = await PaymentMethod.findOne({ name: name.trim(), _id: { $ne: req.params.id } });
      if (exists) {
        req.flash("error", "A payment method with that name already exists");
        return res.redirect("/admin/product/payment-methods");
      }
      await PaymentMethod.findByIdAndUpdate(req.params.id, {
        name: name.trim(),
        description: (description || '').trim(),
      });
      req.flash("success", "Payment method updated");
      res.redirect("/admin/product/payment-methods");
    } catch (err) {
      console.log(err);
      req.flash("error", "Something went wrong");
      res.redirect("/admin/product/payment-methods");
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
      res.redirect("/admin/product/payment-methods");
    } catch (err) {
      console.log(err);
      res.redirect("/admin/product/payment-methods");
    }
  },
];

exports.deletePaymentMethod = [
  authenticateAdminUser,
  async (req, res) => {
    try {
      await PaymentMethod.findByIdAndDelete(req.params.id);
      req.flash("success", "Payment method deleted");
      res.redirect("/admin/product/payment-methods");
    } catch (err) {
      console.log(err);
      res.redirect("/admin/product/payment-methods");
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
