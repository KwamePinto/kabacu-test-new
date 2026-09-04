const { userMessage } = require("../../services/ourdatastore");
const { purchaseData } = require("../../services/dataProviders");
const { notify } = require("../../services/userNotificationService");
const Product = require("../../models/ProductsModal");
const Checkout = require("../../models/CheckoutModal");
const User = require("../../models/UserModel");
const Cart = require("../../models/CartModal");
const Wallet = require("../../models/WalletModal");
const TopUp = require("../../models/TopUpModal");
const Transaction = require("../../models/TransactionModel");
const Conversion = require("../../models/ConversionModal");
const CoursePurchase = require("../../models/CoursePurchaseModel");
const PaymentMethod = require("../../models/PaymentMethodModel");
const CountryWallet = require("../../models/CountryWalletModel");
const SpecialCode = require("../../models/SpecialReferralCodeModel");
const ReferralCodeRequest = require("../../models/ReferralCodeRequestModel");
const referralCodeService = require("../../services/referralCodeService");
const marketService = require("../../services/marketService");
const axios = require("axios");
const crypto = require("crypto");
const mongoose = require("mongoose");

const referralService = require("../../services/referralService");
const Referral = require("../../models/ReferralModel");
const ReferralCommission = require("../../models/ReferralCommissionModel");
const ReferralSettings = require("../../models/ReferralSettingsModel");
const {
  resolveViewerCountry,
  setWalletCountry,
  countryFilter,
  toName: countryName,
  toCode,
  DEFAULT_COUNTRY,
} = require("../../utils/country");
const walletUtil = require("../../utils/wallet");
const { generateSignature, verifySignature } = require("../../utils/palmpay");
const { transferRPToBittoken } = require("../../services/bittokenService");
const SiteSettings = require("../../models/SiteSettingsModel");
const Beneficiary = require("../../models/BeneficiaryModel");

exports.packagesView = async (req, res) => {
  try {
    // =====================================
    // PRODUCTS
    // =====================================
    // All queries run in parallel and are bounded to what the view renders —
    // the home page only shows 8 data cards and 4 cards per category strip.
    // .lean() skips Mongoose document hydration; these are read-only here.

    const byNewest = { createdAt: -1 };

    // Signed-in users only see their own market; signed-out visitors see the
    // market they picked in the header, or everything if they haven't picked.
    const viewer = await resolveViewerCountry(req);
    const market = countryFilter(viewer);

    const [
      dataProducts,
      automobileProducts,
      electronicProducts,
      coursesProducts,
      user,
    ] = await Promise.all([
      Product.find({ category: "DATA", ...market }).sort(byNewest).limit(60).lean(),
      Product.find({ category: "AUTOMOBILE", ...market }).sort(byNewest).limit(5).lean(),
      Product.find({ category: "ELECTRONICS", ...market }).sort(byNewest).limit(5).lean(),
      Product.find({ category: "COURSES", ...market }).sort(byNewest).limit(5).lean(),
      req.user ? User.findById(req.user.id).lean() : null,
    ]);

    // =====================================
    // RENDER
    // =====================================

    res.render("webview/index", {
      dataProducts,

      automobileProducts,

      electronicProducts,

      coursesProducts,

      user,

      viewerCountry: viewer,
      viewerCountryName: viewer.code ? countryName(viewer.code) : '',
    });
  } catch (error) {
    console.log(error);

    res.send("Error loading products");
  }
};
// exports.checkout = (req,res)=>{

// res.render('webview/checkout')

// }

exports.dataForm = async (req, res) => {
  try {
    res.render("webview/dataform");
  } catch (error) {}
};

// CREATE CHECKOUT
exports.initiateCheckout = async (req, res) => {
  try {
    const { packageId, phone } = req.body;

    const userId = req.user.id;

    const newCheckout = await Checkout.create({
      user: userId,
      product: packageId,
      phone,
    });

    res.json({ success: true });
  } catch (error) {
    console.log(error);
    res.json({ success: false, message: "Error creating checkout" });
  }
};

// ADD BENEFICIARY
exports.addBeneficiary = async (req, res) => {
  try {
    const userId = req.user.id;
    const { phone, network, nickname } = req.body;

    if (!/^\d{11}$/.test(phone || "")) {
      return res.json({ success: false, message: "Phone number must be exactly 11 digits" });
    }

    const existing = await Beneficiary.findOne({ user: userId, phone, is_deleted: 0 });
    if (existing) {
      return res.json({ success: false, message: "This number is already saved" });
    }

    const beneficiary = await Beneficiary.create({
      user: userId,
      phone,
      network: network || "",
      nickname: (nickname || "").trim(),
    });

    res.json({ success: true, beneficiary });
  } catch (error) {
    console.log(error);
    res.json({ success: false, message: "Error saving beneficiary" });
  }
};

// DELETE BENEFICIARY
exports.deleteBeneficiary = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const beneficiary = await Beneficiary.findOne({ _id: id, user: userId });
    if (!beneficiary) {
      return res.json({ success: false, message: "Beneficiary not found" });
    }

    beneficiary.is_deleted = 1;
    await beneficiary.save();

    res.json({ success: true });
  } catch (error) {
    console.log(error);
    res.json({ success: false, message: "Error deleting beneficiary" });
  }
};

// VIEW CHECKOUT
exports.checkoutPage = async (req, res) => {
  try {
    const userId = req.user.id;

    const [user, checkout, wallet] = await Promise.all([
      User.findById(userId),
      Checkout.findOne({ user: userId })
        .sort({ createdAt: -1 })
        .populate("product"),
      Wallet.findOne({ user: userId }),
    ]);

    /* The balance shown on checkout is the one being spent, so it has to be
       the ACTIVE market's — reading balances.NAIRA here showed a Naira figure
       to a user paying from another wallet. */
    const checkoutMarket = walletUtil.marketOf((await resolveViewerCountry(req)).walletCountry);
    const walletBalance = walletUtil.getBalance(wallet, checkoutMarket);
    const checkoutCurrency = await marketService.currency(checkoutMarket);

    if (!checkout) {
      return res.render("webview/checkout", {
        user,
        checkout: null,
        walletBalance,
      });
    }

    res.render("webview/checkout", { user, checkout, walletBalance, checkoutCurrency });
  } catch (error) {
    console.log("ERROR:", error);
    res.send("Error loading checkout");
  }
};

exports.walletCheckout = async (req, res) => {
  try {
    const userId = req.user.id;

    const checkout = await Checkout.findOne({ user: userId })
      .sort({ createdAt: -1 })
      .populate("product");

    if (!checkout) {
      req.flash("error", "No checkout found");
      return res.redirect("/checkout");
    }

    const amount = checkout.product.dataDetails.amount;

    const user = await User.findById(userId);

    if (!user) {
      req.flash("error", "User not found");
      return res.redirect("/checkout");
    }

    if (user.walletBalance < amount) {
      req.flash("error", "Insufficient balance");
      return res.redirect("/my-wallet");
    }

    // Deduct balance
    user.walletBalance -= amount;
    await user.save();

    // ✅ FIX PHONE
    let phone = checkout.phone.trim();
    phone = phone.replace(/\D/g, "");

    if (phone.startsWith("234")) {
      phone = "0" + phone.slice(3);
    }

    if (phone.length !== 11) {
      req.flash("error", "Phone number must be 11 digits");
      return res.redirect("/checkout");
    }

    const apiResponse = await purchaseData(checkout.product, phone);

    console.log("About to save transaction...");

    let txStatus = "failed";
    if (apiResponse.status === "success") txStatus = "success";
    else if (apiResponse.status === "pending") txStatus = "pending";

    await Transaction.create({
      user: userId,
      package: checkout.product._id,
      phone: phone,
      amount,
      status: txStatus,
      provider: checkout.product.dataDetails.provider === "GSUBZ" ? "GSUBZ" : "ODS",
      reference: `TX-${Date.now()}`,
      apiResponse,
    });

    console.log("API RESPONSE:", apiResponse);

    if (apiResponse.status === "pending") {
      req.flash("success", "Your order is being processed. Please wait a few minutes — do not retry.");
      return res.redirect("/checkout");
    }

    if (apiResponse.status !== "success") {
      user.walletBalance += amount;
      await user.save();

      req.flash("error", userMessage(apiResponse));
      return res.redirect("/checkout");
    }

    req.flash("success", "Payment successful, data sent!");
    return res.redirect("/checkout");
  } catch (error) {
    console.log(error);
    req.flash("error", "Wallet payment error");
    return res.redirect("/checkout");
  }
};

exports.history = async (req, res) => {
  try {
    const userId = req.user.id;

    const [user, transactions, coursePurchases] = await Promise.all([
      User.findById(userId),
      Transaction.find({ user: userId })
        .populate("product")
        .populate("products.product")
        .sort({ createdAt: -1 }),
      CoursePurchase.find({ user: userId }).sort({ createdAt: -1 }),
    ]);

    res.render("webview/history", { user, transactions, coursePurchases });
  } catch (error) {
    console.log(error);

    res.send("Error loading history");
  }
};

exports.retryTransaction = async (req, res) => {
  try {
    const { transactionId } = req.body;

    const tx = await Transaction.findById(transactionId).populate("product");

    if (!tx) {
      return res.json({ success: false, message: "Transaction not found" });
    }

    if (tx.status === "success") {
      return res.json({ success: false, message: "Already successful" });
    }

    if (tx.status === "pending") {
      return res.json({ success: false, message: "This transaction is still processing. Please wait a few minutes before checking back." });
    }

    const wallet = await Wallet.findOne({ user: tx.user });

    if (!wallet) {
      return res.json({ success: false, message: "Wallet not found" });
    }

    const product = tx.product || tx.products?.[0]?.product;

    if (!product || !product.dataDetails) {
      return res.json({ success: false, message: "Invalid product data" });
    }

    // Reflects what this retry actually attempts — see the identical note in
    // apiControllers/transactionController.js::retryTransaction.
    tx.provider = product.dataDetails.provider === "GSUBZ" ? "GSUBZ" : "ODS";

    const apiResponse = await purchaseData(product, tx.phone);

    if (apiResponse.status === "success") {
      if (wallet.balances.NAIRA < tx.amount) {
        return res.json({
          success: false,
          insufficientBalance: true,
          message: "Insufficient balance",
          requiredAmount: tx.amount,
          currentBalance: wallet.balances.NAIRA,
        });
      }

      wallet.balances.NAIRA -= tx.amount;
      await wallet.save();

      tx.status = "success";

      if (tx.rpEarned > 0) {
        await User.findByIdAndUpdate(tx.user, {
          $inc: { rpBalance: tx.rpEarned },
        });
      }
    } else if (apiResponse.status === "pending") {
      tx.status = "pending";
    } else {
      tx.status = "failed";
    }

    tx.apiResponse = apiResponse;
    await tx.save();

    return res.json({
      success: tx.status === "success",
      pending: tx.status === "pending",
      message: tx.status === "pending"
        ? "Your order is still being processed. Please wait a few minutes — do not retry again."
        : userMessage(apiResponse),
    });
  } catch (error) {
    console.log(error);
    return res.json({
      success: false,
      message: "Retry failed",
    });
  }
};

exports.myTopUps = async (req, res) => {
  try {
    const userId = req.user.id;

    const [user, topups] = await Promise.all([
      User.findById(userId),
      TopUp.find({ user: userId }).sort({ createdAt: -1 }),
    ]);

    res.render("webview/myTopUps", {
      title: "My Top Ups",
      user,
      topups,
    });
  } catch (error) {
    console.log(error);

    res.render("webview/myTopUps", {
      title: "My Top Ups",
      topups: [],
    });
  }
};

exports.addToCart = async (req, res) => {
  try {
    const userId = req.user.id;
    const { productId } = req.body;

    let cart = await Cart.findOne({ user: userId });

    if (!cart) {
      cart = new Cart({
        user: userId,
        items: [{ product: productId, quantity: 1 }],
      });
    } else {
      const itemIndex = cart.items.findIndex(
        (item) => item.product.toString() === productId,
      );

      if (itemIndex > -1) {
        cart.items[itemIndex].quantity += 1;
      } else {
        cart.items.push({ product: productId, quantity: 1 });
      }
    }

    await cart.save();

    res.json({ success: true });
  } catch (error) {
    console.log(error);
    res.json({ success: false, message: "Error adding to cart" });
  }
};

exports.itemCheckout = async (req, res) => {
  try {
    const cart = await Cart.findOne({ user: req.user.id }).populate(
      "items.product",
    );

    if (!cart || cart.items.length === 0) {
      return res.render("webview/item-checkout", { cart: [], total: 0 });
    }

    let total = 0;
    let totalItems = 0;

    const formattedCart = cart.items.map((item) => {
      const product = item.product;

      let name = "";
      let price = 0;

      if (product.category === "AUTOMOBILE") {
        name = `${product.automobileDetails.brand} ${product.automobileDetails.model}`;
        price = product.automobileDetails.price;
      } else if (product.category === "DATA") {
        name = product.dataDetails.plan_name;
        price = product.dataDetails.amount;
      } else if (product.category === "ELECTRONICS") {
        name = product.electronicDetails.itemName;
        price = product.electronicDetails.items_price;
      } else if (product.category === "COURSES") {
        name = product.coursesDetails.title;
        price = product.coursesDetails.course_price;
      }

      const subtotal = price * item.quantity;

      total += subtotal;
      totalItems += item.quantity;

      return {
        product,
        name,
        price,
        quantity: item.quantity,
        subtotal,
      };
    });

    const user = await User.findById(req.user.id);

    res.render("webview/item-checkout", {
      user,
      cart: formattedCart,
      total,
      totalItems,
    });
  } catch (error) {
    console.log(error);
    res.send("Error loading checkout");
  }
};

exports.userWallet = async (req, res) => {
  try {
    const userId = req.user.id;
    const [user, wallet, countryWallets, allMethods] = await Promise.all([
      User.findById(userId),
      Wallet.findOne({ user: userId }),
      CountryWallet.active(),
      PaymentMethod.find({ isActive: true }).sort({ country: 1, createdAt: 1 }).lean(),
    ]);

    /* One entry per live market, whether or not this user holds money in it —
       a market the admin just created has to appear at zero, otherwise there is
       no way to switch to it and fund it. */
    const marketWallets = walletUtil.balancesFor(wallet, countryWallets, allMethods);

    /* Which market's money the page opens on. Their active wallet, but only if
       it is still live: a market the admin has since switched off must not be
       the one selected, or the user lands on funding options that no longer
       exist. Nigeria is the fallback because it is always live. */
    let active = toCode(user && user.walletCountry) || DEFAULT_COUNTRY;
    if (!marketWallets.some((m) => m.country === active)) {
      active = marketWallets.some((m) => m.country === DEFAULT_COUNTRY)
        ? DEFAULT_COUNTRY
        : (marketWallets[0] && marketWallets[0].country) || DEFAULT_COUNTRY;
    }

    res.render("webview/user-wallet", {
      user,
      wallet,
      marketWallets,
      activeMarket: active,
      // The methods for the market being shown, so the existing funding form
      // keeps working unchanged on first render.
      paymentMethods:
        (marketWallets.find((m) => m.country === active) || {}).paymentMethods || [],
    });
  } catch (error) {
    console.log(error);
    res.render("webview/user-wallet", {
      user: null,
      wallet: null,
      marketWallets: [],
      activeMarket: DEFAULT_COUNTRY,
      paymentMethods: [],
    });
  }
};

/**
 * Record a market switch for a signed-in user.
 *
 * The wallet only follows them into a market that has one — see
 * setWalletCountry(). The response says whether it moved so the page can update
 * the balance card without a reload, and reports the market's currency so the
 * client does not have to keep its own copy of the currency table.
 */
/**
 * Record a manual top-up: the user says they have paid through one of the
 * methods the admin registered for their market, and an admin confirms it.
 *
 * Nothing here touches a balance. A market with no gateway behind it has no way
 * for us to know a payment landed, so the money is credited only when an admin
 * confirms — see confirmManualTopUp in the admin controller. Crediting on the
 * user's word would let anyone mint currency.
 */
exports.requestManualTopUp = async (req, res) => {
  try {
    const userId = req.user.id;
    const amount = Number(req.body.amount);

    if (!amount || amount <= 0) {
      return res.json({ success: false, message: "Enter a valid amount." });
    }

    const viewer = await resolveViewerCountry(req);
    const market = walletUtil.marketOf(viewer.walletCountry);

    // Nigeria funds through PalmPay, which is a real gateway — routing it here
    // would put a confirmed payment into a manual approval queue.
    if (market === DEFAULT_COUNTRY) {
      return res.json({
        success: false,
        message: "Naira top-ups go through the payment checkout, not manual confirmation.",
      });
    }

    /* Resolved through the market service, not the collection directly, so an
       un-seeded database still lets Nigerians fund their wallet — the service
       stands Nigeria in when no wallet rows exist. Reading the model here would
       refuse every top-up on a database that simply has not been migrated. */
    const cw = await marketService.market(market);
    if (!cw) {
      return res.json({ success: false, message: "That market is not currently open." });
    }

    /* The method has to be one the admin actually registered for this market.
       Methods that predate country tagging carry no country at all; those belong
       to Nigeria, which is the only market that existed when they were created.
       Matching them for the default market keeps top-ups working on a database
       that has not been migrated — otherwise every method looks foreign and
       nobody can fund a wallet. */
    const methodQuery = {
      name: String(req.body.paymentMethod || "").trim(),
      isActive: true,
    };
    if (market === DEFAULT_COUNTRY) {
      methodQuery.$or = [
        { country: DEFAULT_COUNTRY },
        { country: { $exists: false } },
        { country: null },
        { country: "" },
      ];
    } else {
      methodQuery.country = market;
    }
    const method = await PaymentMethod.findOne(methodQuery).lean();

    if (!method) {
      return res.json({ success: false, message: "Pick a payment method for your market." });
    }

    const reference = `TOPUP-${market}-${Date.now()}-${crypto
      .randomBytes(3)
      .toString("hex")
      .toUpperCase()}`;

    await TopUp.create({
      user: userId,
      amount,
      balanceType: "COUNTRY",
      walletCountry: market,
      isManual: true,
      status: "PENDING",
      reference,
      paymentMethod: method.name,
      userReference: String(req.body.userReference || "").trim(),
    });

    res.json({
      success: true,
      message:
        `Recorded. Once we confirm your ${method.name} payment of ` +
        `${cw.currencySymbol}${amount.toLocaleString()}, it will be added to your ` +
        `${cw.currencyName || cw.country} wallet.`,
    });
  } catch (error) {
    console.log("MANUAL TOPUP ERROR:", error);
    res.json({ success: false, message: "Could not record that top-up." });
  }
};

exports.switchMarket = async (req, res) => {
  try {
    const result = await setWalletCountry(req.user.id, req.body.country);
    if (!result) return res.json({ success: false, message: "Account not found." });

    // Keep the cookie in step: it is what decides which products they see, and
    // resolveViewerCountry reads it on the next request.
    res.cookie("kbc_country", result.code, {
      maxAge: 365 * 24 * 60 * 60 * 1000,
      sameSite: "lax",
      httpOnly: false,
    });

    // Same reason: the service always resolves a currency, so the response never
    // carries a balance with no symbol attached to it.
    const cw = await marketService.market(result.walletCountry);
    const balance = walletUtil.getBalance(
      await Wallet.findOne({ user: req.user.id }).lean(),
      result.walletCountry,
    );

    res.json({
      success: true,
      country: result.code,
      walletCountry: result.walletCountry,
      walletChanged: result.walletChanged,
      balance,
      currencySymbol: (cw && cw.currencySymbol) || "",
      currencyCode: (cw && cw.currencyCode) || "",
    });
  } catch (error) {
    console.log("SWITCH MARKET ERROR:", error);
    res.json({ success: false, message: "Could not switch market." });
  }
};

exports.startTopUp = async (req, res) => {
  try {
    const { amount, balanceType } = req.body;

    if (!amount || amount <= 0) {
      return res.json({ success: false, message: "Invalid amount" });
    }

    if (!["BTT", "RP", "USDT"].includes(balanceType)) {
      return res.json({ success: false, message: "Invalid wallet type" });
    }

    const user = await User.findById(req.user.id);

    if (!user.minerId) {
      return res.json({
        success: false,
        message:
          "You must set your Miner ID in your profile before topping up.",
      });
    }

    const reference = `TOPUP-${balanceType}-${Date.now()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;

    const topup = await TopUp.create({
      user: user._id,
      amount,
      balanceType,
      reference,
    });

    let otpMessage = "OTP sent to your Telegram Bot.";
    try {
      const otpRes = await axios.post(
        `${process.env.BITTOKEN_BASE_URL}/api/user/send-otp`,
        { minerId: user.minerId },
      );
      otpMessage = otpRes.data?.message || otpMessage;
    } catch (apiErr) {
      await TopUp.findByIdAndDelete(topup._id);
      const apiMsg =
        apiErr.response?.data?.message ||
        apiErr.response?.data?.error ||
        "Could not send OTP. Please check your Miner ID or try again later.";
      console.log(
        "TOPUP OTP API ERROR:",
        apiErr.response?.data || apiErr.message,
      );
      return res.json({ success: false, message: apiMsg });
    }

    res.json({ success: true, topupId: topup._id, message: otpMessage });
  } catch (error) {
    console.log("START TOPUP ERROR:", error);
    res.json({ success: false, message: "Failed to start top-up" });
  }
};

// 👉 STEP 2: CONFIRM TOP-UP
exports.confirmTopUp = async (req, res) => {
  try {
    const { otp, topupId } = req.body;

    const topup = await TopUp.findById(topupId);

    if (!topup || topup.status !== "PENDING") {
      return res.json({ success: false, message: "Invalid session" });
    }

    if (new Date() > topup.expiresAt) {
      return res.json({ success: false, message: "Session expired" });
    }

    const user = await User.findById(req.user.id);

    let response;
    try {
      response = await axios.post(
        `${process.env.BITTOKEN_BASE_URL}/api/user/deduct-fund`,
        {
          minerId: user.minerId,
          otp,
          amount: topup.amount,
          balance_type: topup.balanceType,
        },
      );
    } catch (apiErr) {
      const apiMsg =
        apiErr.response?.data?.message ||
        apiErr.response?.data?.error ||
        "Deduction failed. Please check your OTP and try again.";
      console.log(
        "CONFIRM TOPUP API ERROR:",
        apiErr.response?.data || apiErr.message,
      );
      return res.json({ success: false, message: apiMsg });
    }

    if (response.data.status !== 200) {
      return res.json({
        success: false,
        message: response.data.message || "Deduction failed",
      });
    }

    // ✅ Wallet update (NEW LOGIC)
    let wallet = await Wallet.findOne({ user: user._id });

    if (!wallet) {
      wallet = new Wallet({
        user: user._id,
        balances: {
          BTT: 0,
          RP: 0,
          USDT: 0,
        },
      });
    }

    wallet.balances[topup.balanceType] += topup.amount;

    await wallet.save();

    topup.status = "COMPLETED";
    await topup.save();

    res.json({
      success: true,
      message: response.data.message || "Top-up confirmed",
    });
  } catch (error) {
    console.log(error.response?.data || error);
    res.json({ success: false, message: "Top up failed" });
  }
};

exports.payWithWallet = async (req, res) => {
  try {
    const userId = req.user.id;

    const { productId } = req.body;

    const wallet = await Wallet.findOne({
      user: userId,
    });

    if (!wallet) {
      return res.json({
        success: false,
        message: "Wallet not funded",
      });
    }

    let total = 0;
    let totalCost = 0;

    // ✅ TOTAL RP
    let totalRP = 0;

    let itemsToProcess = [];

    let cart = null;

    let apiResponse = null;

    // =====================================
    // ✅ DIRECT PURCHASE
    // =====================================
    if (productId) {
      const product = await Product.findById(productId);

      if (!product) {
        return res.json({
          success: false,
          message: "Product not found",
        });
      }

      let price = 0;

      // DATA
      if (product.category === "DATA") {
        price = product.dataDetails?.amount || 0;
      }

      // COURSES
      else if (product.category === "COURSES") {
        price = product.coursesDetails?.course_price || 0;
      } else {
        return res.json({
          success: false,
          message: "Invalid direct purchase item",
        });
      }

      total     = price;
      totalCost = product.costPrice || 0;

      // ✅ ADD RP
      totalRP += product.reward_point || 0;

      itemsToProcess.push({
        product,
        quantity: 1,
      });
    }

    // =====================================
    // ✅ CART PURCHASE
    // =====================================
    else {
      cart = await Cart.findOne({
        user: userId,
      }).populate("items.product");

      if (!cart || cart.items.length === 0) {
        return res.json({
          success: false,
          message: "Cart is empty",
        });
      }

      cart.items.forEach((item) => {
        const product = item.product;

        let price = 0;

        // AUTOMOBILE
        if (product.category === "AUTOMOBILE") {
          price = item.selectedPrice || product.automobileDetails?.price || 0;
        }

        // ELECTRONICS
        else if (product.category === "ELECTRONICS") {
          price =
            item.selectedPrice || product.electronicDetails?.items_price || 0;
        }

        // DRINKS / WATER
        else if (
          product.category === "DRINKS" ||
          product.category === "WATER"
        ) {
          price = item.selectedPrice || product.item_price || 0;
        }

        // DATA
        else if (product.category === "DATA") {
          price = product.dataDetails?.amount || 0;
        }

        // COURSES
        else if (product.category === "COURSES") {
          price = product.coursesDetails?.course_price || 0;
        }

        total     += price * item.quantity;
        totalCost += (product.costPrice || 0) * item.quantity;

        // ✅ ADD RP
        totalRP += (product.reward_point || 0) * item.quantity;

        itemsToProcess.push(item);
      });
    }

    // =====================================
    // ✅ RATE LIMIT — block rapid retries
    // =====================================
    // For direct DATA purchases only: if the same user has a failed or still-pending
    // transaction for this product in the last 3 minutes, reject immediately.
    // This stops the "keep clicking buy" loop that floods OurDataStore with rejected calls.
    if (productId && itemsToProcess[0]?.product?.category === 'DATA') {
      const COOLDOWN_MS = 3 * 60 * 1000;
      const recentAttempt = await Transaction.findOne({
        user:      userId,
        product:   productId,
        status:    { $in: ['failed', 'pending'] },
        createdAt: { $gte: new Date(Date.now() - COOLDOWN_MS) },
      }).sort({ createdAt: -1 }).lean();

      if (recentAttempt) {
        const elapsed   = Date.now() - new Date(recentAttempt.createdAt).getTime();
        const remaining = Math.ceil((COOLDOWN_MS - elapsed) / 1000);
        const mins = Math.floor(remaining / 60);
        const secs = remaining % 60;
        const waitStr = mins > 0
          ? `${mins} minute${mins !== 1 ? 's' : ''}${secs > 0 ? ` ${secs}s` : ''}`
          : `${secs} second${secs !== 1 ? 's' : ''}`;
        return res.json({
          success: false,
          message: recentAttempt.status === 'pending'
            ? 'Your last purchase is still being processed. Please wait a moment before trying again.'
            : `This purchase failed recently. Please wait ${waitStr} before trying again.`,
        });
      }
    }

    // =====================================
    // ✅ MARKET CHECK
    // =====================================
    /* Money may only buy what is sold in its own market. The wallets are
       separate currencies with no rate between them, so spending Cedis on a
       Nigerian bundle would be charging one number against another — the
       balance would move by an amount that means nothing.

       Refused before the debit, never after, so there is no refund to make. */
    // resolveViewerCountry memoises on the request, so this is free when the
    // country middleware already ran and one light lookup when it did not.
    const buyerMarket = walletUtil.marketOf(
      (await resolveViewerCountry(req)).walletCountry
    );

    const foreign = itemsToProcess.filter((item) => {
      const pc = toCode(item.product && item.product.country) || DEFAULT_COUNTRY;
      return pc !== buyerMarket;
    });

    if (foreign.length) {
      const names = foreign
        .map((i) => (i.product.dataDetails && i.product.dataDetails.plan_type) || i.product.item_name || 'item')
        .slice(0, 3)
        .join(', ');
      const theirMarket = countryName(
        toCode(foreign[0].product.country) || DEFAULT_COUNTRY
      );
      return res.json({
        success: false,
        message:
          `Your ${countryName(buyerMarket)} wallet cannot buy ${names}, which is sold in ` +
          `${theirMarket}. Switch to your ${theirMarket} wallet from the wallet page, or ` +
          `choose a product sold in ${countryName(buyerMarket)}.`,
      });
    }

    // =====================================
    // ✅ DEDUCT WALLET (atomic)
    // =====================================
    // Single DB operation: check balance AND deduct atomically.
    // Prevents two simultaneous purchases from both passing the balance check.
    // The path is resolved from the buyer's market, so Nigeria still hits
    // balances.NAIRA and every other market hits its own entry.
    const balPath = walletUtil.balancePath(buyerMarket);
    const walletSnap = await Wallet.findOneAndUpdate(
      { user: userId, [balPath]: { $gte: total } },
      { $inc: { [balPath]: -total } },
      { new: false }
    );
    if (!walletSnap) {
      return res.json({ success: false, message: 'Insufficient wallet balance. Please top up your wallet to continue.' });
    }
    const balanceBefore         = walletUtil.getBalance(walletSnap, buyerMarket);
    const balanceAfterDeduction = balanceBefore - total;

    // Atomic refund helper used by error paths below
    const refundWallet = () =>
      Wallet.findOneAndUpdate({ user: userId }, { $inc: { [balPath]: total } });

    // =====================================
    // ✅ GET CHECKOUT FOR DATA
    // =====================================
    let checkout = null;

    if (itemsToProcess.some((item) => item.product.category === "DATA")) {
      checkout = await Checkout.findOne({
        user: userId,
      }).sort({ createdAt: -1 });
    }

    // =====================================
    // ✅ PROCESS PRODUCTS
    // =====================================
    let successTx = null; // set inside DATA block on success, used at the end

    for (let item of itemsToProcess) {
      const product = item.product;

      // =====================================
      // ✅ DATA PURCHASE
      // =====================================
      if (product.category === "DATA") {
        if (!checkout) {
          await refundWallet();
          return res.json({
            success: false,
            message: "Checkout data not found, refunded",
          });
        }

        let phone = checkout.phone.trim().replace(/\D/g, "");

        if (phone.startsWith("234")) {
          phone = "0" + phone.slice(3);
        }

        if (phone.length !== 11) {
          await refundWallet();
          return res.json({
            success: false,
            message: "Invalid phone number, refunded",
          });
        }

        // Create placeholder transaction BEFORE the API call — ensures a record exists
        // even if the server crashes or loses connection mid-request.
        const tx = await Transaction.create({
          user:          userId,
          product:       itemsToProcess[0]?.product?._id,
          products:      itemsToProcess.map((item) => ({
            product:  item.product._id,
            quantity: item.quantity,
          })),
          phone,
          amount:        total,
          rpEarned:      totalRP,
          walletType:    "NAIRA",
          paymentMethod: "wallet",
          status:        "pending",
          provider:      product.dataDetails.provider === "GSUBZ" ? "GSUBZ" : "ODS",
          reference:     "PAY-" + Date.now() + "-" + crypto.randomBytes(3).toString("hex"),
          balanceBefore,
          balanceAfter:  balanceAfterDeduction,
          apiResponse:   { _reserved: true },
        });

        apiResponse = await purchaseData(product, phone);
        console.log("BUY RESPONSE:", apiResponse);

        // =====================================
        // ⏳ PENDING — do not refund
        // =====================================
        if (apiResponse.status === "pending") {
          tx.apiResponse = apiResponse;
          // rpEarned is deliberately LEFT AS IS. It was set to totalRP when the
          // placeholder was created, and the poller credits it only once the
          // provider confirms delivery — gated on `if (tx.rpEarned > 0)`.
          // Zeroing it here meant every timed-out purchase that later resolved
          // to success credited nothing and displayed 0 RP forever, which is
          // what produced the 0-RP "Success" rows in the admin table.
          await tx.save();

          notify(userId, {
            type: 'attention',
            text: `Your data order of ₦${total.toLocaleString()} is being verified. We'll update you shortly.`,
            link: '/user/transaction-history',
          });

          return res.json({
            success: false,
            pending: true,
            message: "Your order is being processed. Please wait a few minutes — do not retry. Check your transaction history for the update.",
          });
        }

        // =====================================
        // ❌ REFUND IF FAILED
        // =====================================
        if (apiResponse.status !== "success") {
          await refundWallet();

          tx.status       = "failed";
          tx.rpEarned     = 0;
          tx.balanceAfter = balanceBefore; // wallet was refunded, so final balance is back to original
          tx.apiResponse  = apiResponse;
          await tx.save();

          notify(userId, {
            type: 'refund',
            text: `Your data order of ₦${total.toLocaleString()} could not be completed. ₦${total.toLocaleString()} has been refunded to your wallet.`,
            link: '/user/transaction-history',
          });

          return res.json({
            success: false,
            message: userMessage(apiResponse, "Data purchase failed, refunded"),
          });
        }

        // Success — update the placeholder record instead of creating a new transaction
        tx.status      = "success";
        tx.rpEarned    = totalRP;
        tx.markup      = total - totalCost;
        tx.apiResponse = apiResponse;
        await tx.save();

        successTx = tx;
      }
    }

    // =====================================
    // ✅ SAVE SUCCESS TRANSACTION (non-DATA)
    // =====================================
    if (!successTx) {
      // Cart with no DATA items — create the transaction record now
      successTx = await Transaction.create({
        user:          userId,
        product:       itemsToProcess[0]?.product?._id,
        products:      itemsToProcess.map((item) => ({
          product:  item.product._id,
          quantity: item.quantity,
        })),
        phone:         checkout?.phone || "",
        amount:        total,
        markup:        total - totalCost,
        rpEarned:      totalRP,
        walletType:    "NAIRA",
        paymentMethod: "wallet",
        status:        "success",
        reference:     "PAY-" + Date.now() + "-" + crypto.randomBytes(3).toString("hex"),
        balanceBefore,
        balanceAfter:  balanceAfterDeduction,
        apiResponse,
      });
    }

    // =====================================
    // ✅ CREDIT USER RP
    // =====================================
    await User.findByIdAndUpdate(
      userId,
      {
        $inc: {
          rpBalance: totalRP,
        },
      },
    );

    // =====================================
    // ✅ CLEAR CART
    // =====================================
    if (cart) {
      cart.items = [];

      await cart.save();
    }

    notify(userId, {
      type: 'success',
      text: `Data purchase of ₦${total.toLocaleString()} was successful. Your data is on its way.`,
      link: '/user/transaction-history',
    });

    // Referral payout — pays this user's referrer if this was their first
    // purchase. Swallows its own errors so it can never fail a completed sale.
    await referralService.handlePurchase(userId, { amount: total });

    // Ongoing commission for the referrer, once this buyer has qualified.
    // Paid on top — the buyer was charged `total` in full and keeps all
    // `totalRP`, so revenue and profit reporting are unaffected. Wallet-aware:
    // credited in the same market the buyer paid in.
    await referralService.handleCommission(userId, {
      amount: total,
      market: buyerMarket,
      transactionId: successTx && successTx._id,
    });

    // =====================================
    // ✅ SUCCESS RESPONSE
    // =====================================
    res.json({
      success: true,

      message: "Payment successful",

      balance: balanceAfterDeduction,

      rpEarned: totalRP,

      transaction: successTx,
    });
  } catch (error) {
    console.log(error);

    res.json({
      success: false,

      message: "Payment failed",
    });
  }
};

exports.createPalmPayPayment = async (req, res) => {
  try {
    const userId = req.user.id;
    const { amount } = req.body;

    // =====================================
    // VALIDATE AMOUNT
    // =====================================

    const nairaAmount = parseFloat(amount);

    if (!nairaAmount || nairaAmount <= 0) {
      return res.json({
        success: false,
        message: "Invalid amount",
      });
    }

    // Store internally as kobo
    const koboAmount = Math.round(nairaAmount * 100);

    // =====================================
    // GENERATE ORDER DETAILS
    // =====================================

    const requestTime = Date.now();

    const nonceStr = crypto.randomBytes(16).toString("hex");

    const orderId = `PALM-${Date.now()}-${userId}`;

    const version = "1.1";

    // =====================================
    // PREVENT DUPLICATE REFERENCES
    // =====================================

    const existing = await TopUp.findOne({
      reference: orderId,
    });

    if (existing) {
      return res.json({
        success: false,

        message: "Duplicate transaction reference",
      });
    }

    // =====================================
    // PALMPAY PAYLOAD
    // =====================================

    const payload = {
      requestTime,

      amount: koboAmount,

      orderId,

      payeeName: "Wallet Topup",

      payeeBankCode: "MTN",

      payeeBankAccNo: "0591990607",

      callBackUrl: process.env.PALMPAY_CALLBACK_URL,

      notifyUrl: process.env.PALMPAY_WEBHOOK_URL,

      currency: "NGN",

      remark: "Wallet Topup " + orderId,

      version,

      nonceStr,
    };

    // =====================================
    // SIGN REQUEST
    // =====================================

    const signature = generateSignature(
      payload,

      process.env.PALMPAY_PRIVATE_KEY,
    );

    // =====================================
    // CREATE PALMPAY ORDER
    // =====================================

    const response = await axios.post(
      `${process.env.PALMPAY_BASE_URL}/api/v2/payment/merchant/createorder`,

      payload,

      {
        headers: {
          "Content-Type": "application/json",

          Authorization: `Bearer ${process.env.PALMPAY_APP_ID}`,

          Signature: signature,

          CountryCode: "NG",
        },
      },
    );

    // =====================================
    // CHECK RESPONSE
    // =====================================

    if (!response.data || response.data.respCode !== "00000000") {
      return res.json({
        success: false,

        message: response.data?.respMsg || "PalmPay request failed",
      });
    }

    // =====================================
    // SAVE TOPUP RECORD
    // =====================================

    const topUp = await TopUp.create({
      user: userId,

      // Stored in Kobo
      amount: koboAmount,

      // Stored for display/reporting
      nairaAmount: nairaAmount,

      balanceType: "NAIRA",

      paymentMethod: "PalmPay",

      reference: orderId,

      status: "PENDING",

      palmPayOrderId: response.data.data.orderNo,

      sdkSessionId: response.data.data.sdkSessionId,

      payToken: response.data.data.payToken,

      checkoutUrl: response.data.data.checkoutUrl,

      apiResponse: response.data,
    });

    // =====================================
    // SUCCESS RESPONSE
    // =====================================

    return res.json({
      success: true,

      paymentUrl: response.data.data.checkoutUrl,

      topUpId: topUp._id,
    });
  } catch (error) {
    console.log(error.response?.data || error);

    return res.json({
      success: false,

      message: "PalmPay error",

      error: error.response?.data || error.message,
    });
  }
};

////////////////////////////////////////////////////////
exports.palmPayWebhook = async (req, res) => {
  try {
    console.log("PALMPAY WEBHOOK:", req.body);

    const verified = verifySignature(
      req.body,

      process.env.PALMPAY_PUBLIC_KEY,
    );

    console.log("SIGNATURE VERIFIED:", verified);

    if (!verified) {
      return res.status(400).json({
        success: false,

        message: "Invalid PalmPay signature",
      });
    }

    const topUp = await TopUp.findOne({
      reference: req.body.orderId,
    });

    console.log("FOUND TOPUP:", topUp);

    if (!topUp || !topUp.amount || topUp.amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid or corrupted topup record",
      });
    }

    // if (!topUp) {

    //     return res.status(404)
    //     .json({

    //         success: false,

    //         message:
    //             "TopUp not found"
    //     });
    // }

    if (req.body.orderStatus == 2) {
      // Atomic compare-and-swap: claim this webhook only if the wallet hasn't been credited yet.
      // Two simultaneous webhooks can't both pass — only one gets a non-null result.
      const claimed = await TopUp.findOneAndUpdate(
        { _id: topUp._id, walletCredited: { $ne: true } },
        { $set: { walletCredited: true, webhookData: req.body, webhookVerified: true, status: 'COMPLETED' } },
        { new: false }
      );
      if (!claimed) {
        return res.json({ success: true, message: 'TopUp already processed' });
      }

      // Atomic wallet credit — prevents lost increments from concurrent saves.
      // new:false returns the pre-update document, which is the only reliable
      // way to capture the true before-balance without re-reading (and racing).
      const walletField = `balances.${topUp.balanceType}`;
      const creditAmount = topUp.amount / 100;
      const walletSnap = await Wallet.findOneAndUpdate(
        { user: topUp.user },
        { $inc: { [walletField]: creditAmount } },
        { upsert: true, new: false, setOnInsert: { user: topUp.user, balances: { BTT: 0, RP: 0, USDT: 0, NAIRA: 0 } } }
      );

      // Record both sides so this top-up reads like any other statement row.
      // Never let a bookkeeping failure undo a credit that already succeeded.
      try {
        const before = (walletSnap && walletSnap.balances && walletSnap.balances[topUp.balanceType]) || 0;
        await TopUp.updateOne(
          { _id: topUp._id },
          { $set: { balanceBefore: before, balanceAfter: before + creditAmount, balanceSource: 'live' } }
        );
      } catch (snapErr) {
        console.error('[palmpay webhook] balance snapshot failed:', snapErr.message);
      }

      return res.json({
        success: true,
        message: "Wallet funded successfully",
      });
    }

    // Failed payment — safe to process multiple times
    if (!topUp.walletCredited) {
      topUp.webhookData     = req.body;
      topUp.webhookVerified = true;
      topUp.status          = "FAILED";
      await topUp.save();
    }

    return res.json({
      success: false,
      message: "Payment failed",
    });
  } catch (error) {
    console.log(error);

    return res.status(500).json({
      success: false,

      error: error.message,
    });
  }
};

exports.convertUSDTtoNaira = async (req, res) => {
  try {
    const userId = req.user.id;

    const { amount } = req.body;

    // VALIDATION
    if (!amount || amount <= 0) {
      return res.json({
        success: false,
        message: "Invalid amount",
      });
    }

    // GET USER WALLET
    const wallet = await Wallet.findOne({
      user: userId,
    });

    if (!wallet) {
      return res.json({
        success: false,
        message: "Wallet not found",
      });
    }

    // CHECK BALANCE
    if (wallet.balances.USDT < amount) {
      return res.json({
        success: false,
        message: "Insufficient USDT balance",
      });
    }

    // =========================================
    // FETCH RATES FROM MULTIPLE SOURCES
    // =========================================

    let coinGeckoRate = 0;
    let coinbaseRate = 0;
    let cryptoCompareRate = 0;

    try {
      const cgRes = await axios.get(
        "https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=ngn",
      );
      coinGeckoRate = cgRes.data.tether.ngn || 0;
    } catch (err) {
      console.log("CoinGecko Error:", err.message);
    }

    try {
      const cbRes = await axios.get(
        "https://api.coinbase.com/v2/exchange-rates?currency=USDT",
      );
      coinbaseRate = parseFloat(cbRes.data.data.rates.NGN) || 0;
    } catch (err) {
      console.log("Coinbase Error:", err.message);
    }

    try {
      const ccRes = await axios.get(
        "https://min-api.cryptocompare.com/data/price?fsym=USDT&tsyms=NGN",
      );
      cryptoCompareRate = ccRes.data.NGN || 0;
    } catch (err) {
      console.log("CryptoCompare Error:", err.message);
    }

    const validRates = [coinGeckoRate, coinbaseRate, cryptoCompareRate].filter(
      (r) => r > 0,
    );
    if (validRates.length === 0) {
      return res.json({
        success: false,
        message: "Unable to fetch exchange rate",
      });
    }

    const lowestRate = Math.min(...validRates);
    const markupPercent = 5;
    const conversionMarkup = (lowestRate * markupPercent) / 100;
    const finalRate = lowestRate - conversionMarkup;
    const nairaAmount = amount * finalRate;
    const rateSpread = Math.max(...validRates) - lowestRate;

    // Snapshot both sides before mutating so the conversion can be shown on
    // the admin account statement like any other wallet movement.
    const nairaBefore = wallet.balances.NAIRA || 0;
    const usdtBefore  = wallet.balances.USDT || 0;

    wallet.balances.USDT -= amount;
    wallet.balances.NAIRA += nairaAmount;
    await wallet.save();

    await Conversion.create({
      user: userId,
      balanceBefore: nairaBefore,
      balanceAfter: nairaBefore + nairaAmount,
      usdtBalanceBefore: usdtBefore,
      usdtBalanceAfter: usdtBefore - amount,
      balanceSource: 'live',
      usdtAmount: amount,
      nairaAmount,
      finalRate,
      lowestRate,
      providerARate: coinGeckoRate,
      providerBRate: coinbaseRate,
      providerCRate: cryptoCompareRate,
      conversionMarkup,
      rateSpread,
      status: "COMPLETED",
    });

    res.json({
      success: true,
      amountConverted: amount,
      rates: {
        coinGeckoRate,
        coinbaseRate,
        cryptoCompareRate,
        lowestRate,
        finalRate,
      },
      markupPercent,
      nairaAmount,
      balances: { USDT: wallet.balances.USDT, NAIRA: wallet.balances.NAIRA },
    });
  } catch (error) {
    console.log(error);

    res.json({
      success: false,
      message: "Conversion failed",
    });
  }
};

exports.previewUSDTConversion = async (req, res) => {
  try {
    const { amount } = req.body;

    if (!amount || amount <= 0) {
      return res.json({
        success: false,
      });
    }

    let coinGeckoRate = 0;
    let coinbaseRate = 0;
    let cryptoCompareRate = 0;

    try {
      const cgRes = await axios.get(
        "https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=ngn",
      );
      coinGeckoRate = cgRes.data.tether.ngn || 0;
    } catch (err) {
      console.log(err.message);
    }

    try {
      const cbRes = await axios.get(
        "https://api.coinbase.com/v2/exchange-rates?currency=USDT",
      );
      coinbaseRate = parseFloat(cbRes.data.data.rates.NGN) || 0;
    } catch (err) {
      console.log(err.message);
    }

    try {
      const ccRes = await axios.get(
        "https://min-api.cryptocompare.com/data/price?fsym=USDT&tsyms=NGN",
      );
      cryptoCompareRate = ccRes.data.NGN || 0;
    } catch (err) {
      console.log(err.message);
    }

    const validRates = [coinGeckoRate, coinbaseRate, cryptoCompareRate].filter(
      (r) => r > 0,
    );
    if (validRates.length === 0) {
      return res.json({ success: false, message: "Rate unavailable" });
    }

    const lowestRate = Math.min(...validRates);
    const finalRate = lowestRate - (lowestRate * 5) / 100;
    const nairaAmount = amount * finalRate;

    res.json({ success: true, nairaAmount, finalRate });
  } catch (error) {
    console.log(error);

    res.json({
      success: false,
    });
  }
};

exports.userProfile = async (req, res) => {
  try {
    const userId = req.user.id;
    const [user, recentOrders, recentTopups, totalTopups] = await Promise.all([
      User.findById(userId),
      Transaction.find({ user: userId })
        .sort({ createdAt: -1 })
        .limit(5)
        .populate("product products.product"),
      TopUp.find({ user: userId, status: "COMPLETED" })
        .sort({ createdAt: -1 })
        .limit(5),
      TopUp.countDocuments({ user: userId, status: "COMPLETED" }),
    ]);

    // ── Referrals ────────────────────────────────────────────────────────
    // Full referral detail (code, list, rewards) now lives on its own page
    // (GET /referrals) — the profile just needs enough for a summary link.
    const [referralsCount, referralsRewarded] = await Promise.all([
      Referral.countDocuments({ referrer: userId }),
      Referral.countDocuments({ referrer: userId, status: 'rewarded' }),
    ]);

    res.render("webview/profile", {
      user,
      recentOrders,
      recentTopups,
      totalTopups,
      referralsCount,
      referralsRewarded,
    });
  } catch (error) {
    console.log(error);
  }
};

exports.referralsPage = async (req, res) => {
  try {
    const userId = req.user.id;

    // Existing accounts were backfilled by scripts/backfill-referral-codes.js;
    // this also covers anyone created since.
    const referralCode = await referralService.ensureReferralCode(userId);

    const [referralSettings, myReferral, myReferrals] = await Promise.all([
      ReferralSettings.getSettings(),
      Referral.findOne({ referred: userId }).populate('referrer', 'username'),
      Referral.find({ referrer: userId })
        .sort({ createdAt: -1 })
        .populate('referred', 'username')
        .populate('rewardProduct', 'dataDetails')
        .lean(),
    ]);

    // =====================================
    // REWARD TOTALS
    // =====================================
    // "claimed"   already paid out — the referred user hit the threshold
    // "unclaimed" still owed — they signed up but haven't purchased yet
    //
    // Paid rewards read their own snapshot (rewardType/rewardAmount are frozen
    // per-Referral at payout, so changing the settings never rewrites history).
    // Outstanding ones are *projected* from today's settings, because what they
    // will eventually be worth isn't decided until they qualify.
    //
    /* The three cards map onto the three reward types the system supports.
       'money' and 'data' are read here too, purely for HISTORIC rows: the
       reward type used to include both, and a referral rewarded under the old
       system keeps that value forever (see the note on ReferralModel.rewardType).
       There is no live path that produces either any more, so they fold into
       the closest card that still exists rather than getting one of their own —
       money is closest to a spendable-currency reward (usdt card), and a data
       grant has no ongoing home now that packages are not on offer, so it is
       simply not counted (it was never a summable amount anyway). */
    const rewardStats = {
      rp:   { total: 0, claimed: 0, unclaimed: 0 },
      btt:  { total: 0, claimed: 0, unclaimed: 0 },
      usdt: { total: 0, claimed: 0, unclaimed: 0 },
    };

    const CARD_FOR_TYPE = { rewardpoint: 'rp', BTT: 'btt', USDT: 'usdt', money: 'usdt' };

    myReferrals.forEach(r => {
      if (r.status === 'rewarded') {
        const card = CARD_FOR_TYPE[r.rewardType];
        if (!card) return;
        rewardStats[card].claimed += (r.rewardAmount || 0);
      }
    });

    // Anything not yet paid and not void is still in play.
    const outstanding = myReferrals.filter(r => r.status === 'pending' || r.status === 'qualified').length;

    if (outstanding > 0 && referralSettings.isActive) {
      const card = CARD_FOR_TYPE[referralSettings.rewardType];
      if (card) rewardStats[card].unclaimed = outstanding * (referralSettings.amount || 0);
    }

    Object.keys(rewardStats).forEach(k => {
      const s = rewardStats[k];
      s.total = Math.round((s.claimed + s.unclaimed) * 100) / 100;
      s.claimed = Math.round(s.claimed * 100) / 100;
      s.unclaimed = Math.round(s.unclaimed * 100) / 100;
    });

    // =====================================
    // PER-REFERRAL REWARD LABEL
    // =====================================
    // What each row is worth: the real figure once paid, otherwise what it
    // would be worth on today's settings if that person completes a purchase.
    let projectedLabel = 'No reward set';
    if (referralSettings.isActive) {
      if (referralSettings.rewardType === 'rewardpoint' && referralSettings.amount > 0) {
        projectedLabel = `+${referralSettings.amount} RP`;
      } else if ((referralSettings.rewardType === 'BTT' || referralSettings.rewardType === 'USDT') && referralSettings.amount > 0) {
        projectedLabel = `${referralSettings.amount.toLocaleString()} ${referralSettings.rewardType}`;
      }
    } else {
      projectedLabel = 'Programme paused';
    }

    function rewardLabelFor(r) {
      if (r.status === 'rewarded') {
        if (r.rewardType === 'rewardpoint')                       return `+${r.rewardAmount || 0} RP`;
        if (r.rewardType === 'BTT' || r.rewardType === 'USDT')    return `${(r.rewardAmount || 0).toLocaleString()} ${r.rewardType}`;
        // Historic rows only — 'money' and 'data' are not awarded any more.
        if (r.rewardType === 'money')                             return `₦${(r.rewardAmount || 0).toLocaleString()}`;
        if (r.rewardType === 'data') {
          const d = r.rewardProduct && r.rewardProduct.dataDetails;
          return d ? `${d.plan_type || 'Data'}` : 'Data bundle';
        }
        return 'Rewarded';
      }
      if (r.status === 'void') return 'Not eligible';
      // pending / qualified — awaiting the referred user's first purchase
      return projectedLabel;
    }

    myReferrals.forEach(r => { r.rewardLabel = rewardLabelFor(r); });

    // The referral list itself is paginated — everything else on the page
    // (stats, rewards) is computed from the full unpaginated set above.
    const perPage = 10;
    const pages   = Math.ceil(myReferrals.length / perPage) || 1;
    const page    = Math.min(Math.max(parseInt(req.query.page) || 1, 1), pages);

    /* Code ownership: the current code, every code they have ever held, and
       whatever they have queued. Past codes are shown because they still work —
       a user who has moved to a vanity code needs to know their old links have
       not broken. */
    const [codeHistory, pendingRequest, recentRequests] = await Promise.all([
      referralCodeService.historyFor(userId),
      ReferralCodeRequest.findOne({ user: userId, status: 'pending' }).lean(),
      ReferralCodeRequest.find({ user: userId, status: { $ne: 'pending' } })
        .sort({ createdAt: -1 }).limit(5).lean(),
    ]);

    const codePricing = referralCodeService.pricingFrom(referralSettings);

    // Commission ledger: every individual payout, most recent first. Capped
    // rather than paginated — plenty for "reveal the list" on this page, and
    // avoids a second pagination system alongside the referrals list above.
    const COMMISSION_LIST_CAP = 100;
    const [commissionEvents, commissionTotalsRaw] = await Promise.all([
      ReferralCommission.find({ referrer: userId })
        .sort({ createdAt: -1 })
        .limit(COMMISSION_LIST_CAP)
        .populate('referred', 'username')
        .lean(),
      ReferralCommission.aggregate([
        { $match: { referrer: new mongoose.Types.ObjectId(userId) } },
        { $group: { _id: '$currencyCode', total: { $sum: '$amount' }, symbol: { $first: '$currencySymbol' }, count: { $sum: 1 } } },
      ]),
    ]);
    const commissionTotalCount = commissionTotalsRaw.reduce((s, t) => s + t.count, 0);

    res.render("webview/referrals", {
      referralCode,
      referralSettings,
      myReferral,
      myReferrals,
      codeHistory,
      pendingRequest,
      recentRequests,
      codePricing,
      myReferralsPage: myReferrals.slice((page - 1) * perPage, page * perPage),
      referralPagination: { pages, current: page, hasNext: page < pages, hasPrev: page > 1 },
      referralsRewarded: myReferrals.filter(r => r.status === 'rewarded').length,
      rewardStats,
      commissionEvents,
      commissionTotals: commissionTotalsRaw,
      commissionTotalCount,
      commissionListCap: COMMISSION_LIST_CAP,
    });
  } catch (error) {
    console.log(error);
  }
};

exports.editUserProfile = async (req, res) => {
  try {
    const userId = req.user.id;

    const { username, email, minerId } = req.body;

    // Check if email belongs to another user
    const existingEmail = await User.findOne({
      email,
      _id: { $ne: userId },
    });

    if (existingEmail) {
      req.flash("error", "Email already exists");
      return res.redirect("/user-profile");
    }

    // Check if username belongs to another user
    const existingUsername = await User.findOne({
      username,
      _id: { $ne: userId },
    });

    if (existingUsername) {
      req.flash("error", "Username already exists");
      return res.redirect("/user-profile");
    }

    const currentUser = await User.findById(userId);

    let parsedMinerId = null;
    if (minerId && minerId.trim() !== "") {
      const trimmed = minerId.trim();
      const isNum = /^\d+$/.test(trimmed);
      if (!isNum || trimmed.length < 8 || trimmed.length > 11) {
        req.flash("error", "Miner ID must be between 8 and 11 digits (numbers only)");
        return res.redirect("/user-profile");
      }
      parsedMinerId = Number(trimmed);

      // Check if minerId belongs to another user
      const existingMinerId = await User.findOne({
        minerId: parsedMinerId,
        _id: { $ne: userId },
      });

      if (existingMinerId) {
        req.flash("error", "Miner ID already taken");
        return res.redirect("/user-profile");
      }

      // Validate via API only when the miner ID has actually changed
      if (currentUser.minerId !== parsedMinerId) {
        try {
          await axios.post(
            `${process.env.BITTOKEN_BASE_URL}/api/user/kabacu/verify/user`,
            { email_id: email, miner_id: parsedMinerId },
          );
        } catch (apiErr) {
          console.log(
            "MINER ID VERIFY ERROR:",
            apiErr.response?.data || apiErr.message,
          );
          req.flash(
            "error",
            `Your email (${email}) and the miner ID you entered (${parsedMinerId}) do not match an account on BitToken App.`,
          );
          return res.redirect("/user-profile");
        }
      }
    }

    await User.findByIdAndUpdate(
      userId,
      {
        username,
        email,
        minerId: parsedMinerId,
      },
      { returnDocument: "after" },
    );

    req.flash("success", "Profile updated successfully");
    res.redirect("/user-profile");
  } catch (error) {
    console.log(error);
    req.flash("error", "Something went wrong");
    res.redirect("/user-profile");
  }
};

// UPDATE CHECKOUT
exports.editItem = async (req, res) => {
  const { phone, network } = req.body;

  await Checkout.findByIdAndUpdate(req.params.id, {
    phone,
  });

  res.redirect("/checkout");
};

// DELETE CHECKOUT
exports.deleteItem = async (req, res) => {
  await Checkout.findByIdAndDelete(req.params.id);

  res.redirect("/");
};

exports.claimRP = async (req, res) => {
  try {
    const userId = req.user.id;

    // =====================================
    // GET USER
    // =====================================

    const user = await User.findById(userId);

    if (!user) {
      return res.json({
        success: false,

        message: "User not found",
      });
    }

    // =====================================
    // CHECK RP
    // =====================================

    if (user.rpBalance <= 0) {
      return res.json({
        success: false,

        message: "No RP available",
      });
    }

    // =====================================
    // GET WALLET
    // =====================================

    let wallet = await Wallet.findOne({
      user: userId,
    });

    if (!wallet) {
      wallet = await Wallet.create({
        user: userId,

        balances: {
          BTT: 0,

          RP: 0,

          USDT: 0,

          NAIRA: 0,
        },
      });
    }

    // =====================================
    // MOVE RP
    // =====================================

    wallet.balances.RP += user.rpBalance;

    await wallet.save();

    // =====================================
    // RESET USER RP
    // =====================================

    const claimedRP = user.rpBalance;

    user.rpBalance = 0;

    await user.save();

    // =====================================
    // SUCCESS
    // =====================================

    res.json({
      success: true,

      message: `${claimedRP} RP claimed successfully`,
    });
  } catch (error) {
    console.log(error);

    res.json({
      success: false,

      message: "Failed to claim RP",
    });
  }
};

exports.wallet = (req, res) => {
  // wallet deduction logic
  res.send("Processing wallet payment...");
};

exports.conversionHistory = async (req, res) => {
  try {
    const userId = req.user.id;
    const [user, conversions] = await Promise.all([
      User.findById(userId),
      Conversion.find({ user: userId }).sort({ createdAt: -1 }),
    ]);
    res.render("webview/conversion-history", { user, conversions });
  } catch (error) {
    console.log("CONVERSION HISTORY ERROR:", error);
    res.redirect("/user-profile");
  }
};

exports.faqPage = async (req, res) => {
  try {
    const Faq = require('../../models/FaqModel');
    const CATEGORY_ORDER = ['getting-started', 'wallet', 'data', 'courses', 'account', 'rewards'];
    /* `$ne: 'admin'` rather than `audience: 'user'` on purpose: every FAQ
       written before the audience field existed has no such field, and an
       equality match would not match a missing one — which would empty this
       page. $ne matches missing fields, so the pre-existing entries stay.

       The grouping below also only keeps CATEGORY_ORDER categories, so the
       admin manual could not render here anyway; filtering in the query means
       it is never even read. */
    const faqs = await Faq.find({ isActive: true, audience: { $ne: 'admin' } })
      .sort({ category: 1, order: 1 })
      .lean();

    const faqsByCategory = {};
    CATEGORY_ORDER.forEach(function(cat) { faqsByCategory[cat] = []; });
    faqs.forEach(function(faq) {
      if (faqsByCategory[faq.category]) faqsByCategory[faq.category].push(faq);
    });

    res.render('webview/faq', { faqsByCategory, CATEGORY_ORDER });
  } catch (err) {
    console.error('[faqPage]', err);
    res.render('webview/faq', {
      faqsByCategory: { 'getting-started': [], wallet: [], data: [], courses: [], account: [], rewards: [] },
      CATEGORY_ORDER: ['getting-started', 'wallet', 'data', 'courses', 'account', 'rewards'],
    });
  }
};

exports.categoriesPage = (req, res) => {
  res.render("webview/categories");
};

exports.aboutPage = (req, res) => {
  res.render("webview/about");
};

exports.privacyPolicy = (req, res) => {
  res.render("webview/privacy-policy");
};

exports.termsOfUse = (req, res) => {
  res.render("webview/terms");
};

exports.transferRPToBittokenHandler = async (req, res) => {
  try {
    const siteSettings = await SiteSettings.getSettings();
    if (!siteSettings.rpTransferEnabled) {
      return res.json({
        success: false,
        suspended: true,
        message: siteSettings.rpTransferSuspendedMessage,
      });
    }

    const userId = req.user.id;
    const rpAmount = Number(req.body.rpAmount);

    if (isNaN(rpAmount) || rpAmount <= 0) {
      return res.json({
        success: false,
        message: "Enter a valid RP amount greater than 0.",
      });
    }

    const user = await User.findById(userId).select("email minerId");
    if (!user) {
      return res.json({ success: false, message: "User not found." });
    }

    if (!user.minerId) {
      return res.json({
        success: false,
        noMinerId: true,
        message:
          "You have not set up your BitToken Miner ID. Please add it in your profile before transferring Reward Points.",
      });
    }

    const wallet = await Wallet.findOne({ user: userId });
    const currentRP =
      wallet && wallet.balances && wallet.balances.RP ? wallet.balances.RP : 0;

    if (currentRP < rpAmount) {
      return res.json({
        success: false,
        message: "Insufficient Reward Points balance.",
      });
    }

    // Deduct first
    wallet.balances.RP -= rpAmount;
    await wallet.save();

    // Call BitToken API
    let apiResult;
    try {
      apiResult = await transferRPToBittoken({
        minerId: user.minerId,
        email: user.email,
        rpAmount,
      });
    } catch (apiErr) {
      wallet.balances.RP += rpAmount;
      await wallet.save();
      const errMsg =
        apiErr.response && apiErr.response.data && apiErr.response.data.message
          ? apiErr.response.data.message
          : apiErr.message || "BitToken API error";
      return res.json({
        success: false,
        message: `Transfer failed: ${errMsg}`,
      });
    }

    const accepted =
      apiResult &&
      (apiResult.status === true ||
        apiResult.status === 200 ||
        apiResult.success === true);
    if (!accepted) {
      wallet.balances.RP += rpAmount;
      await wallet.save();
      return res.json({
        success: false,
        message:
          (apiResult && apiResult.message) ||
          "Transfer was not accepted by BitToken.",
      });
    }

    const ref =
      "BTT-RP-" +
      Date.now() +
      "-" +
      Math.random().toString(36).substr(2, 5).toUpperCase();
    await Transaction.create({
      user: userId,
      amount: rpAmount,
      walletType: "RP",
      paymentMethod: "BitToken Transfer",
      status: "success",
      reference: ref,
    });

    res.json({
      success: true,
      message: `${rpAmount} RP successfully transferred to your BitToken account.`,
    });
  } catch (error) {
    console.error("[transferRPToBittokenHandler]", error);
    res.json({
      success: false,
      message: "Something went wrong. Please try again.",
    });
  }
};

// =====================================
// REFERRALS
// =====================================

/**
 * Applies another user's referral code to the signed-in account.
 * All validation (self-referral, one-code-only, account-age ordering) lives in
 * referralService so the rules stay in one place.
 */
exports.applyReferral = async (req, res) => {
  try {
    const result = await referralService.applyReferralCode(req.user.id, req.body.code);
    res.json(result);
  } catch (err) {
    console.error("[applyReferral]", err);
    res.json({ success: false, message: "Could not apply that code. Please try again." });
  }
};

/* ── Buying a referral code ─────────────────────────────────────────────────
   Two routes to a better code: pick one from the pool an admin has reserved,
   or choose your own. Both go through the same review queue, and neither
   charges anything until an admin approves — see referralCodeService. */

/** Codes still for sale, with what each costs and earns. */
exports.availableSpecialCodes = async (req, res) => {
  try {
    const settings = await ReferralSettings.getSettings();
    const pricing = referralCodeService.pricingFrom(settings);

    if (!pricing.isActive) {
      return res.json({ success: false, message: 'Referral codes are not on sale at the moment.' });
    }

    // Unassigned and active only — an assigned code belongs to somebody.
    const pool = await SpecialCode.find({ isActive: true, permittedUser: null })
      .sort({ price: 1, code: 1 })
      .limit(300)
      .lean();

    // A code someone else has already queued is effectively gone, so it is not
    // offered. Showing it would let two users race for the same code and one
    // be rejected after the fact.
    const queued = await ReferralCodeRequest.find({ status: 'pending' }).select('code').lean();
    const taken = new Set(queued.map(q => q.code));

    const codes = pool
      .filter(c => !taken.has(c.code))
      .map(c => {
        const { price, currency } = referralCodeService.specialPriceFor(c, settings);
        return { id: c._id, code: c.code, price, currency, note: c.note || '' };
      });

    res.json({
      success: true,
      codes,
      rewardBonusPercent: pricing.special.rewardBonusPercent,
      commissionBonusPercent: pricing.special.commissionBonusPercent,
    });
  } catch (error) {
    console.log('AVAILABLE SPECIAL CODES ERROR:', error);
    res.json({ success: false, message: 'Could not load the reserved codes.' });
  }
};

/**
 * Live availability check for a code a user is typing.
 *
 * Purely advisory — requestCode validates again server-side. Its job is to tell
 * someone their code is taken while they are still typing, rather than after
 * they submit and wait for a review.
 */
exports.checkCustomCode = async (req, res) => {
  try {
    const settings = await ReferralSettings.getSettings();
    const result = await referralCodeService.validateCustomCode(
      req.body.code, req.user.id, settings,
    );
    res.json({ success: result.ok, message: result.message });
  } catch (error) {
    console.log('CHECK CUSTOM CODE ERROR:', error);
    res.json({ success: false, message: 'Could not check that code.' });
  }
};

/** Submit a request for a reserved or custom code. */
exports.requestReferralCode = async (req, res) => {
  try {
    const result = await referralCodeService.requestCode(req.user.id, {
      type: req.body.type,
      code: req.body.code,
      specialId: req.body.specialId,
    });
    res.json(result);
  } catch (error) {
    console.log('REQUEST REFERRAL CODE ERROR:', error);
    res.json({ success: false, message: 'Could not send that request.' });
  }
};

/** Withdraw a pending request. */
exports.cancelReferralCodeRequest = async (req, res) => {
  try {
    const result = await referralCodeService.cancelRequest(req.params.id, req.user.id);
    res.json(result);
  } catch (error) {
    console.log('CANCEL CODE REQUEST ERROR:', error);
    res.json({ success: false, message: 'Could not withdraw that request.' });
  }
};
