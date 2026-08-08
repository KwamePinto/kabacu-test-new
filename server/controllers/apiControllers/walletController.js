const Wallet   = require('../../models/WalletModal');
const { notify } = require('../../services/userNotificationService');
const User     = require('../../models/UserModel');
const TopUp    = require('../../models/TopUpModal');
const Product  = require('../../models/ProductsModal');
const Checkout = require('../../models/CheckoutModal');
const Transaction = require('../../models/TransactionModel');
const SiteSettings = require('../../models/SiteSettingsModel');
const { buyData, networkCode, userMessage } = require('../../services/ourdatastore');
const { generateSignature, verifySignature } = require('../../utils/palmpay');
const axios  = require('axios');
const crypto = require('crypto');

exports.getWallet = async (req, res) => {
  try {
    const wallet = await Wallet.findOne({ user: req.user.id });

    if (!wallet) {
      return res.json({
        success: true,
        balances: { BTT: 0, RP: 0, USDT: 0, NAIRA: 0 }
      });
    }

    res.json({ success: true, balances: wallet.balances });

  } catch (error) {
    console.log(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.payWithWallet = async (req, res) => {
  try {
    const userId = req.user.id;
    const { productId } = req.body;

    const wallet = await Wallet.findOne({ user: userId });

    if (!wallet) {
      return res.json({ success: false, message: 'Wallet not funded' });
    }

    let total = 0;
    let totalRP = 0;
    let itemsToProcess = [];
    let apiResponse = null;

    if (productId) {
      const product = await Product.findById(productId);
      if (!product) return res.json({ success: false, message: 'Product not found' });

      let price = 0;
      if (product.category === 'DATA')    price = product.dataDetails?.amount || 0;
      else if (product.category === 'COURSES') price = product.coursesDetails?.course_price || 0;
      else return res.json({ success: false, message: 'Invalid purchase item' });

      total   = price;
      totalRP = product.reward_point || 0;
      itemsToProcess.push({ product, quantity: 1 });
    } else {
      return res.json({ success: false, message: 'productId is required' });
    }

    // Atomic balance check + deduction — prevents double-spend if two requests arrive simultaneously.
    // Returns the document as it was BEFORE the decrement (new: false), so we know balanceBefore.
    const walletSnap = await Wallet.findOneAndUpdate(
      { user: userId, 'balances.NAIRA': { $gte: total } },
      { $inc: { 'balances.NAIRA': -total } },
      { new: false }
    );
    if (!walletSnap) {
      return res.json({ success: false, message: 'Insufficient wallet balance. Please top up your wallet to continue.' });
    }
    const balanceBefore         = walletSnap.balances.NAIRA;
    const balanceAfterDeduction = balanceBefore - total;

    // Atomic refund helper used by error paths below
    const refundWallet = () =>
      Wallet.findOneAndUpdate({ user: userId }, { $inc: { 'balances.NAIRA': total } });

    let checkout = null;
    if (itemsToProcess.some(i => i.product.category === 'DATA')) {
      checkout = await Checkout.findOne({ user: userId }).sort({ createdAt: -1 });
    }

    for (const item of itemsToProcess) {
      const product = item.product;

      if (product.category === 'DATA') {
        if (!checkout) {
          await refundWallet();
          return res.json({ success: false, message: 'Checkout data not found, refunded' });
        }

        let phone = checkout.phone.trim().replace(/\D/g, '');
        if (phone.startsWith('234')) phone = '0' + phone.slice(3);

        if (phone.length !== 11) {
          await refundWallet();
          return res.json({ success: false, message: 'Invalid phone number, refunded' });
        }

        // Create placeholder transaction BEFORE the API call — ensures a record exists
        // even if the server crashes or loses connection mid-request.
        const tx = await Transaction.create({
          user:          userId,
          product:       product._id,
          products:      itemsToProcess.map(i => ({ product: i.product._id, quantity: i.quantity })),
          phone,
          amount:        total,
          rpEarned:      totalRP,
          walletType:    'NAIRA',
          paymentMethod: 'wallet',
          status:        'pending',
          reference:     'PAY-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex'),
          balanceBefore,
          balanceAfter:  balanceAfterDeduction,
          apiResponse:   { _reserved: true },
        });

        try {
          apiResponse = await Promise.race([
            buyData({
              network:   await networkCode(product.dataDetails.network),
              phone,
              data_plan: product.dataDetails.plan_id
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Request timeout')), 25000))
          ]);
        } catch (err) {
          if (err.response) {
            console.log('API HTTP ERROR:', err.response.status, err.response.data);
            apiResponse = { status: 'fail' };
          } else {
            const reason = err.message === 'Request timeout' ? 'timeout' : (err.code || err.message);
            console.log('API NO-RESPONSE:', reason);
            apiResponse = { status: 'pending', _timedOut: true, _reason: reason };
          }
        }

        if (apiResponse.status === 'pending') {
          tx.apiResponse = apiResponse;
          await tx.save();
          notify(userId, {
            type: 'attention',
            text: `Your data order of ₦${total.toLocaleString()} is being verified. We'll update you shortly.`,
            link: '/user/transaction-history',
          });
          return res.json({ success: false, pending: true, message: 'Your order is being processed. Please wait a few minutes — do not retry. Check your transaction history for the update.' });
        }

        if (apiResponse.status !== 'success') {
          await refundWallet();
          tx.status       = 'failed';
          tx.balanceAfter = balanceBefore; // wallet was refunded, so final balance is back to original
          tx.apiResponse  = apiResponse;
          await tx.save();
          notify(userId, {
            type: 'refund',
            text: `Your data order of ₦${total.toLocaleString()} failed. ₦${total.toLocaleString()} has been refunded to your wallet.`,
            link: '/user/transaction-history',
          });
          return res.json({ success: false, message: userMessage(apiResponse, 'Data purchase failed, refunded') });
        }

        // Success — update the placeholder record instead of creating a new transaction
        tx.status      = 'success';
        tx.rpEarned    = totalRP;
        tx.markup      = total - (product.costPrice || 0);
        tx.apiResponse = apiResponse;
        await tx.save();

        await User.findByIdAndUpdate(userId, { $inc: { rpBalance: totalRP } });
        notify(userId, {
          type: 'success',
          text: `Data purchase of ₦${total.toLocaleString()} was successful. Your data is on its way.`,
          link: '/user/transaction-history',
        });
        return res.json({
          success:     true,
          message:     'Payment successful',
          balance:     balanceAfterDeduction,
          rpEarned:    totalRP,
          transaction: tx,
        });
      }
    }

    // Non-DATA products (COURSES etc.) reach here — no API call was made
    const transaction = await Transaction.create({
      user:          userId,
      product:       itemsToProcess[0]?.product?._id,
      products:      itemsToProcess.map(i => ({ product: i.product._id, quantity: i.quantity })),
      phone:         checkout?.phone || '',
      amount:        total,
      markup:        total - (itemsToProcess[0]?.product?.costPrice || 0),
      rpEarned:      totalRP,
      walletType:    'NAIRA',
      paymentMethod: 'wallet',
      status:        'success',
      reference:     'PAY-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex'),
      balanceBefore,
      balanceAfter:  balanceAfterDeduction,
      apiResponse,
    });

    await User.findByIdAndUpdate(userId, { $inc: { rpBalance: totalRP } });

    notify(userId, {
      type: 'success',
      text: `Data purchase of ₦${total.toLocaleString()} was successful. Your data is on its way.`,
      link: '/user/transaction-history',
    });

    res.json({
      success:    true,
      message:    'Payment successful',
      balance:    balanceAfterDeduction,
      rpEarned:   totalRP,
      transaction,
    });

  } catch (error) {
    console.log(error);
    res.status(500).json({ success: false, message: 'Payment failed' });
  }
};

exports.startTopUp = async (req, res) => {
  try {
    const { amount, balanceType } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid amount' });
    }

    if (!['BTT', 'RP', 'USDT'].includes(balanceType)) {
      return res.status(400).json({ success: false, message: 'Invalid wallet type. Use BTT, RP or USDT' });
    }

    const siteSettings = await SiteSettings.getSettings();
    if (balanceType === 'BTT' && !siteSettings.bttTopupEnabled) {
      return res.json({ success: false, suspended: true, message: siteSettings.bttTopupSuspendedMessage });
    }
    if (balanceType === 'USDT' && !siteSettings.usdtTopupEnabled) {
      return res.json({ success: false, suspended: true, message: siteSettings.usdtTopupSuspendedMessage });
    }

    const user = await User.findById(req.user.id);

    const topup = await TopUp.create({ user: user._id, amount, balanceType });

    const otpRes = await axios.post(
      `${process.env.BITTOKEN_BASE_URL}/api/user/send-otp`,
      { minerId: user.minerId }
    );

    res.json({ success: true, topupId: topup._id, message: otpRes.data.message || 'OTP sent to your Telegram Bot.' });

  } catch (error) {
    console.log(error);
    res.status(500).json({ success: false, message: 'Failed to start top-up' });
  }
};

exports.confirmTopUp = async (req, res) => {
  try {
    const { otp, topupId } = req.body;

    const topup = await TopUp.findById(topupId);

    if (!topup || topup.status !== 'PENDING') {
      return res.status(400).json({ success: false, message: 'Invalid session' });
    }

    if (new Date() > topup.expiresAt) {
      return res.status(400).json({ success: false, message: 'Session expired' });
    }

    const user = await User.findById(req.user.id);

    const response = await axios.post(
      `${process.env.BITTOKEN_BASE_URL}/api/user/deduct-fund`,
      { minerId: user.minerId, otp, amount: topup.amount, balance_type: topup.balanceType }
    );

    if (response.data.status !== 200) {
      return res.json({ success: false, message: 'Deduction failed' });
    }

    let wallet = await Wallet.findOne({ user: user._id });
    if (!wallet) {
      wallet = new Wallet({ user: user._id, balances: { BTT: 0, RP: 0, USDT: 0 } });
    }

    wallet.balances[topup.balanceType] += topup.amount;
    await wallet.save();

    topup.status = 'COMPLETED';
    await topup.save();

    res.json({ success: true, message: response.data.message || 'Top-up confirmed', balances: wallet.balances });

  } catch (error) {
    console.log(error.response?.data || error);
    res.status(500).json({ success: false, message: 'Top up failed' });
  }
};

exports.claimRP = async (req, res) => {
  try {
    const userId = req.user.id;

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    if (user.rpBalance <= 0) {
      return res.json({ success: false, message: 'No RP available to claim' });
    }

    let wallet = await Wallet.findOne({ user: userId });
    if (!wallet) {
      wallet = await Wallet.create({ user: userId, balances: { BTT: 0, RP: 0, USDT: 0, NAIRA: 0 } });
    }

    const claimedRP = user.rpBalance;
    wallet.balances.RP += claimedRP;
    await wallet.save();

    user.rpBalance = 0;
    await user.save();

    res.json({ success: true, message: `${claimedRP} RP claimed successfully`, claimedRP });

  } catch (error) {
    console.log(error);
    res.status(500).json({ success: false, message: 'Failed to claim RP' });
  }
};

exports.previewUSDTConversion = async (req, res) => {
  try {
    const { amount } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid amount' });
    }

    const siteSettings = await SiteSettings.getSettings();
    if (!siteSettings.usdtTopupEnabled) {
      return res.json({ success: false, suspended: true, message: siteSettings.usdtTopupSuspendedMessage });
    }

    let coinGeckoRate     = 0;
    let coinbaseRate      = 0;
    let cryptoCompareRate = 0;

    try {
      const cgRes = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=ngn');
      coinGeckoRate = cgRes.data.tether.ngn || 0;
    } catch (e) { console.log('CoinGecko error:', e.message); }

    try {
      const cbRes = await axios.get('https://api.coinbase.com/v2/exchange-rates?currency=USDT');
      coinbaseRate = parseFloat(cbRes.data.data.rates.NGN) || 0;
    } catch (e) { console.log('Coinbase error:', e.message); }

    try {
      const ccRes = await axios.get('https://min-api.cryptocompare.com/data/price?fsym=USDT&tsyms=NGN');
      cryptoCompareRate = ccRes.data.NGN || 0;
    } catch (e) { console.log('CryptoCompare error:', e.message); }

    const validRates = [coinGeckoRate, coinbaseRate, cryptoCompareRate].filter(r => r > 0);
    if (validRates.length === 0) {
      return res.json({ success: false, message: 'Unable to fetch exchange rate' });
    }

    const lowestRate  = Math.min(...validRates);
    const finalRate   = lowestRate - (lowestRate * 5) / 100;
    const nairaAmount = amount * finalRate;

    res.json({ success: true, nairaAmount, finalRate, lowestRate });

  } catch (error) {
    console.log(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.convertUSDTtoNaira = async (req, res) => {
  try {
    const userId = req.user.id;
    const { amount } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid amount' });
    }

    const siteSettings = await SiteSettings.getSettings();
    if (!siteSettings.usdtTopupEnabled) {
      return res.json({ success: false, suspended: true, message: siteSettings.usdtTopupSuspendedMessage });
    }

    const wallet = await Wallet.findOne({ user: userId });
    if (!wallet) return res.status(404).json({ success: false, message: 'Wallet not found' });

    if (wallet.balances.USDT < amount) {
      return res.json({ success: false, message: 'Insufficient USDT balance' });
    }

    let coinGeckoRate     = 0;
    let coinbaseRate      = 0;
    let cryptoCompareRate = 0;

    try {
      const cgRes = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=ngn');
      coinGeckoRate = cgRes.data.tether.ngn || 0;
    } catch (e) { console.log('CoinGecko error:', e.message); }

    try {
      const cbRes = await axios.get('https://api.coinbase.com/v2/exchange-rates?currency=USDT');
      coinbaseRate = parseFloat(cbRes.data.data.rates.NGN) || 0;
    } catch (e) { console.log('Coinbase error:', e.message); }

    try {
      const ccRes = await axios.get('https://min-api.cryptocompare.com/data/price?fsym=USDT&tsyms=NGN');
      cryptoCompareRate = ccRes.data.NGN || 0;
    } catch (e) { console.log('CryptoCompare error:', e.message); }

    const validRates = [coinGeckoRate, coinbaseRate, cryptoCompareRate].filter(r => r > 0);
    if (validRates.length === 0) {
      return res.json({ success: false, message: 'Unable to fetch exchange rate' });
    }

    const lowestRate       = Math.min(...validRates);
    const conversionMarkup = (lowestRate * 5) / 100;
    const finalRate        = lowestRate - conversionMarkup;
    const nairaAmount      = amount * finalRate;

    wallet.balances.USDT  -= amount;
    wallet.balances.NAIRA += nairaAmount;
    await wallet.save();

    res.json({
      success: true,
      amountConverted: amount,
      nairaAmount,
      rates: { coinGeckoRate, coinbaseRate, cryptoCompareRate, lowestRate, finalRate },
      balances: { USDT: wallet.balances.USDT, NAIRA: wallet.balances.NAIRA },
    });

  } catch (error) {
    console.log(error);
    res.status(500).json({ success: false, message: 'Conversion failed' });
  }
};

exports.createPalmPayPayment = async (req, res) => {
  try {
    const userId = req.user.id;
    const { amount } = req.body;

    const nairaAmount = parseFloat(amount);
    if (!nairaAmount || nairaAmount <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid amount' });
    }

    const koboAmount  = Math.round(nairaAmount * 100);
    const requestTime = Date.now();
    const nonceStr    = crypto.randomBytes(16).toString('hex');
    const orderId     = `PALM-${Date.now()}-${userId}`;
    const version     = '1.1';

    const existing = await TopUp.findOne({ reference: orderId });
    if (existing) return res.json({ success: false, message: 'Duplicate transaction reference' });

    const payload = {
      requestTime,
      amount:        koboAmount,
      orderId,
      payeeName:     'Wallet Topup',
      payeeBankCode: 'MTN',
      payeeBankAccNo: '0591990607',
      callBackUrl:   process.env.PALMPAY_CALLBACK_URL,
      notifyUrl:     process.env.PALMPAY_WEBHOOK_URL,
      currency:      'NGN',
      remark:        'Wallet Topup ' + orderId,
      version,
      nonceStr
    };

    const signature = generateSignature(payload, process.env.PALMPAY_PRIVATE_KEY);

    const response = await axios.post(
      `${process.env.PALMPAY_BASE_URL}/api/v2/payment/merchant/createorder`,
      payload,
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization:  `Bearer ${process.env.PALMPAY_APP_ID}`,
          Signature:      signature,
          CountryCode:    'NG'
        }
      }
    );

    if (!response.data || response.data.respCode !== '00000000') {
      return res.json({ success: false, message: response.data?.respMsg || 'PalmPay request failed' });
    }

    const topUp = await TopUp.create({
      user:            userId,
      amount:          koboAmount,
      nairaAmount,
      balanceType:     'NAIRA',
      paymentMethod:   'PalmPay',
      reference:       orderId,
      status:          'PENDING',
      palmPayOrderId:  response.data.data.orderNo,
      sdkSessionId:    response.data.data.sdkSessionId,
      payToken:        response.data.data.payToken,
      checkoutUrl:     response.data.data.checkoutUrl,
      apiResponse:     response.data
    });

    res.json({ success: true, paymentUrl: response.data.data.checkoutUrl, topUpId: topUp._id });

  } catch (error) {
    console.log(error.response?.data || error);
    res.status(500).json({ success: false, message: 'PalmPay error' });
  }
};

exports.palmPayWebhook = async (req, res) => {
  try {
    const verified = verifySignature(req.body, process.env.PALMPAY_PUBLIC_KEY);
    if (!verified) {
      return res.status(400).json({ success: false, message: 'Invalid signature' });
    }

    const topUp = await TopUp.findOne({ reference: req.body.orderId });
    if (!topUp || !topUp.amount || topUp.amount <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid topup record' });
    }

    if (req.body.orderStatus == 2) {
      // Atomic compare-and-swap: claim this webhook only if the wallet hasn't been credited yet.
      // Two simultaneous webhooks can't both pass — only one gets a non-null result.
      const claimed = await TopUp.findOneAndUpdate(
        { _id: topUp._id, walletCredited: { $ne: true } },
        { $set: { walletCredited: true, webhookData: req.body, webhookVerified: true, status: 'COMPLETED' } },
        { new: false }
      );
      if (!claimed) {
        return res.json({ success: true, message: 'Already processed' });
      }

      const walletField = `balances.${topUp.balanceType}`;
      await Wallet.findOneAndUpdate(
        { user: topUp.user },
        { $inc: { [walletField]: topUp.amount / 100 } },
        { upsert: true, setOnInsert: { user: topUp.user } }
      );

      return res.json({ success: true, message: 'Wallet funded successfully' });
    }

    // Failed payment — safe to process multiple times
    if (!topUp.walletCredited) {
      topUp.webhookData     = req.body;
      topUp.webhookVerified = true;
      topUp.status          = 'FAILED';
      await topUp.save();
    }

    return res.json({ success: false, message: 'Payment failed' });

  } catch (error) {
    console.log(error);
    res.status(500).json({ success: false, error: error.message });
  }
};
