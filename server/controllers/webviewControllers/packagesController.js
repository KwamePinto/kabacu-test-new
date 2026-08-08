const { buyData, networkCode, userMessage } = require("../../services/ourdatastore");
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
const axios = require("axios");
const crypto = require("crypto");
const mongoose = require("mongoose");

const { generateSignature, verifySignature } = require("../../utils/palmpay");
const { transferRPToBittoken } = require("../../services/bittokenService");
const SiteSettings = require("../../models/SiteSettingsModel");
const Beneficiary = require("../../models/BeneficiaryModel");

exports.packagesView = async (req, res) => {
  try {
    const products = await Product.find();

    // =====================================
    // PRODUCTS
    // =====================================

    const dataProducts = await Product.find({
      category: "DATA",
    }).sort({ createdAt: -1 });

    const specialProdtcs = await Product.find({
      category: "DATA",
    })
      .limit(3)
      .sort({ createdAt: -1 });

    const automobileProducts = await Product.find({
      category: "AUTOMOBILE",
    }).sort({ createdAt: -1 });

    const electronicProducts = await Product.find({
      category: "ELECTRONICS",
    }).sort({ createdAt: -1 });

    const coursesProducts = await Product.find({
      category: "COURSES",
    }).sort({ createdAt: -1 });

    const otherProducts = products.filter(
      (p) =>
        p.category !== "DATA" &&
        p.category !== "AUTOMOBILE" &&
        p.category !== "ELECTRONICS" &&
        p.category !== "COURSES",
    );

    // =====================================
    // ✅ GET USER
    // =====================================

    let user = null;

    if (req.user) {
      user = await User.findById(req.user.id);
    }

    // =====================================
    // RENDER
    // =====================================

    res.render("webview/index", {
      dataProducts,

      automobileProducts,

      electronicProducts,

      coursesProducts,

      otherProducts,

      specialProdtcs,

      user,
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

    const walletBalance = wallet?.balances?.NAIRA ?? 0;

    if (!checkout) {
      return res.render("webview/checkout", {
        user,
        checkout: null,
        walletBalance,
      });
    }

    res.render("webview/checkout", { user, checkout, walletBalance });
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

    // const apiResponse = await buyData({
    //   network: checkout.package.network === 'MTN' ? 1 : 2,
    //   phone: phone,
    //   data_plan: checkout.package.plan_id
    // });

    let apiResponse;

    try {
      apiResponse = await Promise.race([
        buyData({
          network: await networkCode(checkout.product.dataDetails.network),
          phone: phone,
          data_plan: checkout.product.dataDetails.plan_id,
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Request timeout')), 25000)),
      ]);
    } catch (err) {
      console.log("API ERROR:", err.response?.data || err.message);
      if (err.response) {
        apiResponse = { status: "fail", message: err.response?.data?.message || "API error" };
      } else {
        const reason = err.message === 'Request timeout' ? 'timeout' : (err.code || err.message);
        apiResponse = { status: "pending", _timedOut: true, _reason: reason };
      }
    }

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

    let apiResponse;

    try {
      apiResponse = await Promise.race([
        buyData({
          network: await networkCode(product.dataDetails.network),
          phone: tx.phone,
          data_plan: product.dataDetails.plan_id,
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Request timeout")), 25000)
        ),
      ]);
    } catch (err) {
      if (err.message === "Request timeout") {
        apiResponse = { status: "pending", _timedOut: true };
      } else {
        apiResponse = { status: "fail", message: "API error" };
      }
    }

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
    const [user, wallet, paymentMethods] = await Promise.all([
      User.findById(userId),
      Wallet.findOne({ user: userId }),
      PaymentMethod.find({ isActive: true }).sort({ createdAt: 1 }),
    ]);
    res.render("webview/user-wallet", { user, wallet, paymentMethods });
  } catch (error) {
    console.log(error);
    res.render("webview/user-wallet", { user: null, wallet: null });
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

    let wallet = await Wallet.findOne({
      user: userId,
    });

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
    // ✅ DEDUCT WALLET (atomic)
    // =====================================
    const currentBalance = wallet ? wallet.balances.NAIRA : 0;

    let balanceBefore;
    let balanceAfterDeduction;

    if (total === 0) {
      // Free item — no deduction needed, so a missing wallet is fine.
      if (!wallet) {
        wallet = await Wallet.create({ user: userId, balances: { NAIRA: 0 } });
      }
      balanceBefore = balanceAfterDeduction = wallet.balances.NAIRA;
    } else {
      // Single DB operation: check balance AND deduct atomically.
      // Prevents two simultaneous purchases from both passing the balance check.
      const walletSnap = await Wallet.findOneAndUpdate(
        { user: userId, 'balances.NAIRA': { $gte: total } },
        { $inc: { 'balances.NAIRA': -total } },
        { new: false }
      );
      if (!walletSnap) {
        return res.json({
          success: false,
          insufficientBalance: true,
          message: 'Insufficient wallet balance. Please top up your wallet to continue.',
          requiredAmount: total,
          currentBalance,
        });
      }
      balanceBefore         = walletSnap.balances.NAIRA;
      balanceAfterDeduction = balanceBefore - total;
    }

    // Atomic refund helper used by error paths below
    const refundWallet = () =>
      Wallet.findOneAndUpdate({ user: userId }, { $inc: { 'balances.NAIRA': total } });

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
          reference:     "PAY-" + Date.now() + "-" + crypto.randomBytes(3).toString("hex"),
          balanceBefore,
          balanceAfter:  balanceAfterDeduction,
          apiResponse:   { _reserved: true },
        });

        try {
          apiResponse = await Promise.race([
            buyData({
              network: await networkCode(product.dataDetails.network),

              phone,

              data_plan: product.dataDetails.plan_id,
            }),

            new Promise((_, reject) =>
              setTimeout(
                () => reject(new Error("Request timeout")),

                25000,
              ),
            ),
          ]);

          console.log("BUY RESPONSE:", apiResponse);
        } catch (err) {
          if (err.response) {
            // OurDataStore sent back an HTTP error — they received and rejected our request.
            // Data was not delivered; safe to refund.
            console.log("API HTTP ERROR:", err.response.status, err.response.data);
            apiResponse = { status: "fail" };
          } else {
            // No response received (timeout, network drop, connection reset, etc.).
            // OurDataStore may have processed the request — keep wallet deducted.
            const reason = err.message === "Request timeout" ? "timeout" : (err.code || err.message);
            console.log("API NO-RESPONSE:", reason);
            apiResponse = { status: "pending", _timedOut: true, _reason: reason };
          }
        }

        // =====================================
        // ⏳ PENDING — do not refund
        // =====================================
        if (apiResponse.status === "pending") {
          tx.apiResponse = apiResponse;
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

      // Atomic wallet credit — prevents lost increments from concurrent saves
      const walletField = `balances.${topUp.balanceType}`;
      await Wallet.findOneAndUpdate(
        { user: topUp.user },
        { $inc: { [walletField]: topUp.amount / 100 } },
        { upsert: true, setOnInsert: { user: topUp.user, balances: { BTT: 0, RP: 0, USDT: 0, NAIRA: 0 } } }
      );

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

    wallet.balances.USDT -= amount;
    wallet.balances.NAIRA += nairaAmount;
    await wallet.save();

    await Conversion.create({
      user: userId,
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
    res.render("webview/profile", {
      user,
      recentOrders,
      recentTopups,
      totalTopups,
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
    const Faq = require('../models/FaqModel');
    const CATEGORY_ORDER = ['getting-started', 'wallet', 'data', 'courses', 'account', 'rewards'];
    const faqs = await Faq.find({ isActive: true }).sort({ category: 1, order: 1 }).lean();

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
