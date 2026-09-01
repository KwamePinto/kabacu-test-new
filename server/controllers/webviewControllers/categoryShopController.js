const Product = require('../../models/ProductsModal')
const Network = require('../../models/NetworkModel')
const Checkout = require('../../models/CheckoutModal')
const User = require('../../models/UserModel')
const Cart = require('../../models/CartModal')
const Wallet = require('../../models/WalletModal')
const Transaction = require('../../models/TransactionModel')
const CoursePurchase = require('../../models/CoursePurchaseModel')
const referralService = require('../../services/referralService')
const { resolveViewerCountry, countryFilter, toName: countryName } = require('../../utils/country')
const axios = require('axios')

const { authenticateUser } = require('../../config/authMiddleware');
const sendEmail = require('../../utils/emailService');

function coursePurchaseEmail({ username, email, courseTitle, free, loginUrl }) {
  const priceLabel = free ? 'Free enrolment' : 'Purchased via Kabacu wallet';
  return `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:32px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);">
        <!-- Header -->
        <tr>
          <td style="background:#47c363;padding:28px 32px;text-align:center;">
            <h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.3px;">You're Enrolled! 🎉</h1>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="padding:32px 32px 24px;">
            <h2 style="margin:0 0 12px;font-size:18px;color:#111827;">Hi ${username},</h2>
            <p style="margin:0 0 20px;color:#374151;line-height:1.7;font-size:14px;">
              Congratulations! You now have full access to the course below. Head over to <strong>CSkillsHub</strong> and log in with your registered email address to begin your learning journey.
            </p>
            <!-- Course box -->
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;margin:0 0 24px;">
              <tr>
                <td style="padding:16px 20px;border-bottom:1px solid #e5e7eb;">
                  <span style="color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:.05em;">Course</span><br>
                  <strong style="color:#111827;font-size:15px;">${courseTitle}</strong>
                </td>
              </tr>
              <tr>
                <td style="padding:16px 20px;border-bottom:1px solid #e5e7eb;">
                  <span style="color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:.05em;">Login Email</span><br>
                  <strong style="color:#111827;font-size:14px;">${email}</strong>
                </td>
              </tr>
              <tr>
                <td style="padding:16px 20px;">
                  <span style="color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:.05em;">Payment</span><br>
                  <strong style="color:#111827;font-size:14px;">${priceLabel}</strong>
                </td>
              </tr>
            </table>
            <!-- CTA -->
            <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
              <tr>
                <td align="center">
                  <a href="${loginUrl}" style="display:inline-block;background:#47c363;color:#ffffff;font-size:14px;font-weight:700;padding:14px 36px;border-radius:6px;text-decoration:none;letter-spacing:.01em;">
                    Start Learning Now
                  </a>
                </td>
              </tr>
            </table>
            <!-- Note -->
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;margin:0 0 20px;">
              <tr>
                <td style="padding:12px 16px;">
                  <p style="margin:0;color:#1e40af;font-size:13px;line-height:1.6;">
                    <strong>Tip:</strong> Log in to CSkillsHub using <strong>${email}</strong> — the same email you use on Kabacu.
                    If this is your first time logging in, use the <em>Forgot Password</em> option to set a new password.
                  </p>
                </td>
              </tr>
            </table>
            <p style="margin:0;color:#9ca3af;font-size:12px;line-height:1.6;">
              If you did not make this purchase, contact us at
              <a href="mailto:support@kabacu.com" style="color:#47c363;">support@kabacu.com</a> immediately.
            </p>
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="background:#f9fafb;padding:16px 32px;text-align:center;border-top:1px solid #e5e7eb;">
            <p style="margin:0;color:#9ca3af;font-size:12px;">&copy; ${new Date().getFullYear()} Kabacu. All rights reserved.</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}




exports.dataCategory = async (req, res) => {
  try {
    const perPage  = 12;
    const reqNet   = (req.query.network || '').toUpperCase();
    const reqPage  = parseInt(req.query.page) || 1;

    /* Fetch active DATA products sorted: network A-Z, lowest price first within each,
       alongside every Network (including soft-deleted ones) so we can resolve each
       product's API provider — a network removed from the admin list must still
       correctly link any existing products carrying its name */
    /* Signed-in users are locked to their profile's market; signed-out
       visitors see whichever market they picked in the header, or all. */
    const viewer = await resolveViewerCountry(req);
    const market = countryFilter(viewer);

    const [all, networkDocs] = await Promise.all([
      Product.find({ category: 'DATA', isActive: { $ne: false }, ...market })
        .sort({ 'dataDetails.network': 1, 'dataDetails.amount': 1 }),
      Network.find({}),
    ]);

    /* Map each configured network name -> its provider's display label (MTN/GLO/Airtel/9mobile) */
    const nameToProvider = new Map();
    networkDocs.forEach(n => nameToProvider.set(n.name.toUpperCase(), Network.providerLabel(n.apiCode)));

    /* Falls back to substring matching for products whose network name isn't a configured Network */
    function resolveProvider(rawName) {
      const upper = (rawName || '').toUpperCase();
      if (nameToProvider.has(upper)) return nameToProvider.get(upper);
      if (upper.indexOf('MTN') !== -1)    return 'MTN';
      if (upper.indexOf('GLO') !== -1)    return 'GLO';
      if (upper.indexOf('AIRTEL') !== -1) return 'Airtel';
      if (upper.indexOf('9MOBILE') !== -1 || upper.indexOf('ETISALAT') !== -1) return '9mobile';
      return 'Others';
    }

    /* Group every product by API provider instead of the raw network name */
    const allGrouped = {};
    all.forEach(p => {
      const provider = resolveProvider(p.dataDetails.network);
      if (!allGrouped[provider]) allGrouped[provider] = [];
      allGrouped[provider].push(p);
    });

    /* Present providers in a stable, canonical order */
    const PROVIDER_ORDER = ['MTN', 'GLO', 'Airtel', '9mobile'];
    const providerKeys = [
      ...PROVIDER_ORDER.filter(p => allGrouped[p]),
      ...Object.keys(allGrouped).filter(p => !PROVIDER_ORDER.includes(p)),
    ];

    /* Build per-provider page slices + pagination metadata */
    const groupedProducts = {};
    const netPagination   = {};

    for (const provider of providerKeys) {
      const items = allGrouped[provider];
      const pages = Math.ceil(items.length / perPage) || 1;
      /* Only the requested provider uses the requested page; others default to 1 */
      const page  = Math.min(Math.max(reqNet === provider.toUpperCase() ? reqPage : 1, 1), pages);

      groupedProducts[provider] = items.slice((page - 1) * perPage, page * perPage);
      netPagination[provider]   = { pages, current: page, hasNext: page < pages, hasPrev: page > 1 };
    }

    const activeNetwork = providerKeys.find(p => p.toUpperCase() === reqNet) || (providerKeys[0] || '');

    res.render('webview/data-category', {
      groupedProducts,
      netPagination,
      activeNetwork,
      viewerCountry: viewer,
      viewerCountryName: viewer.code ? countryName(viewer.code) : '',
    });

  } catch (error) {
    console.log(error);
  }
}

exports.eletronicCategory = async (req,res)=>{
try{
    const electronicProducts = await Product.find({ category: 'ELECTRONICS', isActive: { $ne: false } }).sort({ createdAt: -1 }).limit(9);
    res.render('webview/electronic-category',{
        electronicProducts
    })
}catch(erro){
    console.log(error)
}


}

exports.automobileCategory = async (req,res)=>{
try{
    const automobileProducts = await Product.find({ category: 'AUTOMOBILE', isActive: { $ne: false } }).sort({ createdAt: -1 }).limit(9);
    res.render('webview/automobile-category',{
        automobileProducts
    })
}catch(erro){
    console.log(error)
}


}


// exports.courseCategory = async (req, res) => {
//   const apiUrl = process.env.COURSES_API_URL || 'http://localhost:5000';
//   let courses  = [];
//   let apiError = false;
//
//   try {
//     const response = await axios.get(`${apiUrl}/api/public/courses`, {
//       headers: { 'Cache-Control': 'no-cache' }
//     });
//     const data = response.data;
//     courses = Array.isArray(data)          ? data
//             : Array.isArray(data.courses)  ? data.courses
//             : Array.isArray(data.data)     ? data.data
//             : [];
//   } catch (err) {
//     console.error('[courseCategory]', err.message);
//     apiError = true;
//   }
//
//   res.render('webview/courses-category', { coursesApiUrl: apiUrl, courses, apiError });
// };

// TO RE-ENABLE COURSES: delete this block and uncomment the code above.
exports.courseCategory = async (req, res) => {
  res.render('webview/courses-category', { comingSoon: true, coursesApiUrl: '', courses: [], apiError: false });
};


exports.courseDetail = async (req, res) => {
  try {
    const apiUrl = process.env.COURSES_API_URL || 'http://localhost:5000';
    const response = await axios.get(`${apiUrl}/api/public/courses/${req.params.id}`, {
      headers: { 'Cache-Control': 'no-cache' }
    });
    const data = response.data;
    const course = data.course || data.data || (typeof data === 'object' && !Array.isArray(data) ? data : null);
    if (!course) return res.redirect('/category/course-category');

    let walletBalance = null;
    let alreadyPurchased = false;

    if (req.user) {
      const [user, wallet] = await Promise.all([
        User.findById(req.user.id),
        Wallet.findOne({ user: req.user.id }),
      ]);
      if (wallet) walletBalance = wallet.balances?.NAIRA || 0;
      const email = user?.email?.toLowerCase().trim();
      if (email) {
        const existing = await CoursePurchase.findOne({ email, courseId: String(req.params.id) });
        alreadyPurchased = !!existing;
      }
    }

    res.render('webview/course-detail', {
      course,
      coursesApiUrl: apiUrl,
      walletBalance,
      alreadyPurchased,
      cskillshubLoginUrl: process.env.CSKILLSHUB_LOGIN_URL || 'http://localhost:3000/login',
      hideFooter: true,
    });
  } catch (err) {
    console.error(err);
    res.redirect('/category/course-category');
  }
};

exports.coursePurchase = async (req, res) => {
  const courseId = req.params.id;
  const redirectBase = `/category/course/${courseId}`;

  try {
    const apiUrl = process.env.COURSES_API_URL || 'http://localhost:5000';

    const response = await axios.get(`${apiUrl}/api/public/courses/${courseId}`, {
      headers: { 'Cache-Control': 'no-cache' }
    });
    const data = response.data;
    const course = data.course || data.data || (typeof data === 'object' && !Array.isArray(data) ? data : null);
    if (!course) return res.redirect('/category/course-category');

    const [user, wallet] = await Promise.all([
      User.findById(req.user.id),
      Wallet.findOne({ user: req.user.id }),
    ]);
    if (!user) return res.redirect('/user/login');

    const email = user.email.toLowerCase().trim();
    const price = Number(course.price) || 0;
    const isFree = price === 0;

    const existing = await CoursePurchase.findOne({ email, courseId: String(courseId) });
    if (existing) return res.redirect(`${redirectBase}?already=1`);

    if (isFree) {
      await CoursePurchase.create({
        email,
        user: user._id,
        courseId: String(courseId),
        courseTitle: course.title || '',
        price: 0,
        free: true,
      });
      const loginUrl = process.env.CSKILLSHUB_LOGIN_URL || 'http://localhost:3000/login';
      sendEmail({
        to:      email,
        subject: `You're enrolled in "${course.title || 'your course'}" — Start Learning Now`,
        html:    coursePurchaseEmail({ username: user.username, email, courseTitle: course.title || '', free: true, loginUrl }),
        text:    `Hi ${user.username}, you are now enrolled in "${course.title || ''}". Log in at ${loginUrl} using ${email} to start learning.`,
      }).catch(err => console.error('[coursePurchaseEmail free]', err.message));
      return res.redirect(`${redirectBase}?enrolled=1`);
    }

    // Paid — wallet deduction
    if (!wallet || (wallet.balances?.NAIRA || 0) < price) {
      return res.redirect(`${redirectBase}?insufficient=1`);
    }

    wallet.balances.NAIRA -= price;
    await wallet.save();

    const ref = 'CRS-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6).toUpperCase();

    try {
      await CoursePurchase.create({
        email,
        user: user._id,
        courseId: String(courseId),
        courseTitle: course.title || '',
        price,
        free: false,
        transactionRef: ref,
      });
    } catch (createErr) {
      wallet.balances.NAIRA += price;
      await wallet.save();
      throw createErr;
    }

    const localProduct = await Product.findById(courseId).select('reward_point').lean().catch(() => null);
    const rpEarned = localProduct?.reward_point || 0;

    const courseTx = await Transaction.create({
      user: user._id,
      amount: price,
      walletType: 'NAIRA',
      paymentMethod: 'Wallet',
      status: 'success',
      reference: ref,
      rpEarned,
    });

    if (rpEarned > 0) {
      await User.findByIdAndUpdate(user._id, { $inc: { rpBalance: rpEarned } });
    }

    // A paid course counts as a qualifying first purchase for referrals.
    await referralService.handlePurchase(user._id, { amount: price });

    // Ongoing commission — additive, taken from neither the price nor the
    // buyer's reward points. Courses are always sold in Naira, so the market
    // is fixed here rather than resolved from the buyer's wallet.
    await referralService.handleCommission(user._id, { amount: price, market: 'NG', transactionId: courseTx._id });

    const loginUrl = process.env.CSKILLSHUB_LOGIN_URL || 'http://localhost:3000/login';
    sendEmail({
      to:      email,
      subject: `You're enrolled in "${course.title || 'your course'}" — Start Learning Now`,
      html:    coursePurchaseEmail({ username: user.username, email, courseTitle: course.title || '', free: false, loginUrl }),
      text:    `Hi ${user.username}, you are now enrolled in "${course.title || ''}". Log in at ${loginUrl} using ${email} to start learning.`,
    }).catch(err => console.error('[coursePurchaseEmail paid]', err.message));

    return res.redirect(`${redirectBase}?enrolled=1`);

  } catch (err) {
    console.error(err);
    res.redirect(`${redirectBase}?error=1`);
  }
};

const GAMEMONETIZE_FEED_URL = 'https://gamemonetize.com/feed.php?format=0&num=50&page=1';

exports.gamesCategory = async (req, res) => {
  if (!res.locals.gamesEnabled) return res.redirect('/');

  let games = [];
  let apiError = false;

  try {
    const response = await axios.get(GAMEMONETIZE_FEED_URL, { timeout: 10000 });
    games = Array.isArray(response.data) ? response.data : [];
  } catch (err) {
    console.error('[gamesCategory]', err.message);
    apiError = true;
  }

  res.render('webview/games-category', { games, apiError });
};

exports.p2pCategory = async (req,res)=>{
try{
    
    res.render('webview/p2p-category',{
       
    })
}catch(erro){
    console.log(error)
}


}