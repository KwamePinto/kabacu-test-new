const Faq = require('../../models/FaqModel');
const { authenticateAdminUser } = require('../../config/authMiddleware');

const SEED_FAQS = [
  // ── Getting Started ──────────────────────────────────────────────────────────
  { category: 'getting-started', order: 1, question: 'What is Kabacu?',
    answer: '<p>Kabacu is an all-in-one digital marketplace where you can purchase data bundles, enrol in online courses, and manage your digital wallet — all in one place. We offer competitive pricing and a seamless purchasing experience.</p>' },
  { category: 'getting-started', order: 2, question: 'How do I create an account?',
    answer: '<p>Visit the <a href="/user/signup">Sign Up page</a> and fill in your username, email address, and password. After submitting, you will receive a one-time password (OTP) to your email address to verify your account. Enter the OTP on the <a href="/user/verify-otp">verification page</a> to activate your account.</p>' },
  { category: 'getting-started', order: 3, question: 'How do I verify my account after signing up?',
    answer: '<p>After registration, check your inbox for an email containing your OTP code. Enter it on the <a href="/user/verify-otp">OTP verification page</a>. If you didn\'t receive the email, click <strong>Resend OTP</strong> on that page. Be sure to check your spam/junk folder as well.</p>' },
  { category: 'getting-started', order: 4, question: 'How do I log in to my account?',
    answer: '<p>Go to the <a href="/user/login">Login page</a>, enter your registered email address and password, complete the CAPTCHA, and click <strong>Sign In</strong>. For security, your account will be temporarily locked after 10 failed login attempts within 15 minutes.</p>' },
  { category: 'getting-started', order: 5, question: 'I forgot my password. How do I reset it?',
    answer: '<p>Go to the <a href="/user/forgot-password">Forgot Password page</a> and enter your registered email address. You will receive an OTP by email. Enter the OTP to verify your identity, then set a new password. The entire flow takes less than two minutes.</p>' },

  // ── Wallet & Payments ────────────────────────────────────────────────────────
  { category: 'wallet', order: 1, question: 'What is the Kabacu Wallet?',
    answer: '<p>The Kabacu Wallet is a digital balance you fund once and use to pay for purchases instantly — no need to enter card details every time. Your wallet holds a <strong>Naira (₦)</strong> balance for regular purchases and a <strong>USDT</strong> balance for crypto-to-naira conversions. View your wallet at <a href="/my-wallet">My Wallet</a>.</p>' },
  { category: 'wallet', order: 2, question: 'How do I top up my wallet?',
    answer: '<p>Go to <a href="/my-wallet">My Wallet</a>, click <strong>Top Up</strong>, and choose PalmPay as your payment method. Enter the amount you wish to add, complete the PalmPay checkout, and your wallet will be credited automatically once the payment is confirmed.</p>' },
  { category: 'wallet', order: 3, question: 'What payment method is accepted for wallet top-ups?',
    answer: '<p>Currently, wallet top-ups are processed via <strong>PalmPay</strong>. PalmPay supports debit cards, bank transfers, and PalmPay account balances. Once your wallet is funded, you can use it to pay for all purchases on Kabacu instantly.</p>' },
  { category: 'wallet', order: 4, question: 'How do I pay for an order using my wallet?',
    answer: '<p>Once you have a sufficient Naira balance in your wallet, add the item you want to your <a href="/checkout">checkout</a>, then select <strong>Pay with Wallet</strong>. The amount will be deducted from your Naira balance instantly and your order will be processed immediately.</p>' },
  { category: 'wallet', order: 5, question: 'What is USDT and how do I convert it to Naira?',
    answer: '<p>USDT (Tether) is a stablecoin cryptocurrency pegged to the US Dollar. If you hold USDT, you can convert it to Naira through your <a href="/my-wallet">wallet</a>. Use the <strong>Convert USDT → Naira</strong> option to preview the current exchange rate before confirming. Converted Naira is credited to your wallet balance immediately.</p>' },
  { category: 'wallet', order: 6, question: 'Where can I view my top-up history?',
    answer: '<p>All your wallet top-up transactions are available on the <a href="/my-topUps">My Top-Ups</a> page. For a full record of all purchases and transactions, visit the <a href="/history">Transaction History</a> page.</p>' },

  // ── Data Bundles ─────────────────────────────────────────────────────────────
  { category: 'data', order: 1, question: 'How do I buy a data bundle?',
    answer: '<p>Browse available data bundles on the <a href="/category/data-category">Data Bundles page</a>. Select the bundle you want, enter the phone number it should be activated on, then proceed to <a href="/checkout">checkout</a>. Pay using your wallet balance. Your bundle will be activated within minutes of a successful payment.</p>' },
  { category: 'data', order: 2, question: 'Can I purchase a data bundle for someone else\'s phone number?',
    answer: '<p>Yes. During checkout on the <a href="/data-form">data form</a>, simply enter the recipient\'s phone number rather than your own. Make sure the number matches the correct network for the bundle you are purchasing.</p>' },
  { category: 'data', order: 3, question: 'What happens if my transaction fails?',
    answer: '<p>If a transaction fails, your wallet balance is automatically refunded within minutes. You can also view the failed transaction on your <a href="/history">Transaction History</a> page and use the <strong>Retry</strong> option to attempt the purchase again without re-entering your details.</p>' },
  { category: 'data', order: 4, question: 'Where can I view my purchase history?',
    answer: '<p>Visit the <a href="/history">Transaction History</a> page to see a complete record of all your purchases, including their status (success, pending, or failed). Each entry shows the date, amount, product, and payment method used.</p>' },

  // ── Courses ──────────────────────────────────────────────────────────────────
  { category: 'courses', order: 1, question: 'How do I browse available courses?',
    answer: '<p>Visit the <a href="/category/course-category">Courses page</a>. You can filter courses by category using the pills at the top, or search for a specific course or topic using the search bar. Click any course card to view its full details, including curriculum overview, instructor, and pricing.</p>' },
  { category: 'courses', order: 2, question: 'How do I purchase a course?',
    answer: '<p>Open the course detail page from the <a href="/category/course-category">Courses page</a>, then click <strong>Buy Now</strong>. You must be <a href="/user/login">logged in</a> to purchase. Payment is made directly from your Naira wallet balance. Make sure your wallet is funded before purchasing — you can top it up at <a href="/my-wallet">My Wallet</a>.</p>' },
  { category: 'courses', order: 3, question: 'Are there free courses available?',
    answer: '<p>Yes. Courses listed as <strong>Free</strong> on the <a href="/category/course-category">Courses page</a> require no payment. Simply click <strong>Enrol for Free</strong> on the course detail page while logged in and you will be granted immediate access.</p>' },
  { category: 'courses', order: 4, question: 'How do I access a course after purchasing it?',
    answer: '<p>After a successful enrolment, a confirmation prompt will appear with a <strong>Start Learning Now</strong> button. Click it to be taken to <strong>CSkillsHub</strong> — our dedicated learning platform. Log in there using the same email address you registered with on Kabacu, and all your purchased courses will appear in your dashboard.</p>' },
  { category: 'courses', order: 5, question: 'I already purchased a course. How do I go back to it?',
    answer: '<p>Open the course on the <a href="/category/course-category">Courses page</a> — the button will show <strong>You Have Access</strong> confirming your enrolment. To resume learning, head to <strong>CSkillsHub</strong> and log in with your registered email address.</p>' },

  // ── Account & Profile ────────────────────────────────────────────────────────
  { category: 'account', order: 1, question: 'How do I view or update my profile?',
    answer: '<p>Visit the <a href="/user-profile">My Profile</a> page. From there you can view your username, email, phone number, and country. Click <strong>Edit Profile</strong> to update your information and save the changes.</p>' },
  { category: 'account', order: 2, question: 'How do I change my password?',
    answer: '<p>Go to <a href="/user/profile-change-password">Change Password</a> while logged in. You will be sent an OTP to your registered email address to confirm the request. Once verified, enter and confirm your new password. For security, you can only request a password change 5 times per 15-minute window.</p>' },
  { category: 'account', order: 3, question: 'How do I log out?',
    answer: '<p>Click the <strong>Logout</strong> option in your account menu or navigate directly to <a href="/user/logout">/user/logout</a>. Your session will be ended immediately and you will be redirected to the home page.</p>' },

  // ── Reward Points ────────────────────────────────────────────────────────────
  { category: 'rewards', order: 1, question: 'What are Reward Points (RP)?',
    answer: '<p>Reward Points (RP) are loyalty points you earn automatically on qualifying purchases made on Kabacu. The more you buy, the more points you accumulate. You can view your current RP balance in your <a href="/my-wallet">wallet</a>.</p>' },
  { category: 'rewards', order: 2, question: 'How do I earn Reward Points?',
    answer: '<p>RP are credited to your account automatically after a successful purchase. The number of points earned depends on the value of the transaction. Points appear in your wallet balance shortly after each successful order.</p>' },
  { category: 'rewards', order: 3, question: 'How do I claim my Reward Points?',
    answer: '<p>Go to your <a href="/my-wallet">Wallet</a> page and click <strong>Claim RP</strong>. Your accumulated Reward Points will be converted to Naira and added to your wallet balance, which you can then use immediately for purchases.</p>' },
];

exports.viewPanel = [authenticateAdminUser, async (req, res) => {
  try {
    const count = await Faq.countDocuments();
    if (count === 0) {
      await Faq.insertMany(SEED_FAQS);
    }

    const faqs = await Faq.find().sort({ category: 1, order: 1 }).lean();
    res.render('adminview/faq', {
      layout: 'layouts/adminLayout',
      faqs,
      csrfToken: res.locals.csrfToken,
    });
  } catch (err) {
    console.error('[faqAdmin viewPanel]', err);
    res.render('adminview/faq', {
      layout: 'layouts/adminLayout',
      faqs: [],
      csrfToken: res.locals.csrfToken,
    });
  }
}];

exports.createFaq = [authenticateAdminUser, async (req, res) => {
  try {
    const { question, category, answer, isActive } = req.body;
    if (!question || !category || !answer) {
      return res.json({ success: false, message: 'Question, category, and answer are required.' });
    }

    const count = await Faq.countDocuments({ category });
    const faq = await Faq.create({
      question: question.trim(),
      category,
      answer,
      isActive: isActive !== false && isActive !== 'false',
      order: count + 1,
    });

    res.json({ success: true, message: 'FAQ created successfully.', faq });
  } catch (err) {
    console.error('[faqAdmin createFaq]', err);
    res.json({ success: false, message: 'Server error. Please try again.' });
  }
}];

exports.updateFaq = [authenticateAdminUser, async (req, res) => {
  try {
    const { question, category, answer, isActive } = req.body;
    if (!question || !category || !answer) {
      return res.json({ success: false, message: 'Question, category, and answer are required.' });
    }

    const faq = await Faq.findByIdAndUpdate(
      req.params.id,
      {
        question: question.trim(),
        category,
        answer,
        isActive: isActive !== false && isActive !== 'false',
      },
      { new: true, runValidators: true }
    );

    if (!faq) return res.json({ success: false, message: 'FAQ not found.' });
    res.json({ success: true, message: 'FAQ updated successfully.', faq });
  } catch (err) {
    console.error('[faqAdmin updateFaq]', err);
    res.json({ success: false, message: 'Server error. Please try again.' });
  }
}];

exports.deleteFaq = [authenticateAdminUser, async (req, res) => {
  try {
    const faq = await Faq.findByIdAndDelete(req.params.id);
    if (!faq) return res.json({ success: false, message: 'FAQ not found.' });
    res.json({ success: true, message: 'FAQ deleted.' });
  } catch (err) {
    console.error('[faqAdmin deleteFaq]', err);
    res.json({ success: false, message: 'Server error. Please try again.' });
  }
}];
