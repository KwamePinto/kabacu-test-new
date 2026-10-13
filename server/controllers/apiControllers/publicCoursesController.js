const crypto = require('crypto');
const Product = require('../../models/ProductsModal');
const CoursePurchase = require('../../models/CoursePurchaseModel');
const User = require('../../models/UserModel');
const ExternalRpCredit = require('../../models/ExternalRpCreditModel');

exports.getCourses = async (req, res) => {
  try {
    const courses = await Product.find({
      category: 'COURSES',
      'coursesDetails.published': true
    })
      .sort({ createdAt: -1 })
      .select('_id images coursesDetails.title coursesDetails.courseCategory coursesDetails.difficulty');

    const data = courses.map(c => ({
      id:         c._id,
      title:      c.coursesDetails?.title || '',
      thumbnail:  c.images?.[0] || null,
      category:   c.coursesDetails?.courseCategory || '',
      difficulty: c.coursesDetails?.difficulty || '',
    }));

    res.json({ success: true, courses: data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.getCourse = async (req, res) => {
  try {
    const course = await Product.findOne({
      _id: req.params.id,
      category: 'COURSES',
      'coursesDetails.published': true
    });

    if (!course) {
      return res.status(404).json({ success: false, message: 'Course not found' });
    }

    const d = course.coursesDetails || {};

    res.json({
      success: true,
      course: {
        id:                course._id,
        title:             d.title || '',
        thumbnail:         course.images?.[0] || null,
        category:          d.courseCategory || '',
        difficulty:        d.difficulty || '',
        instructor:        d.instructor || '',
        price:             d.course_price || 0,
        description:       d.course_description || '',
        overview:          d.overview || '',
        whatYouWillLearn:  d.whatYouWillLearn || [],
        chapterCount:      d.chapterCount || 0,
        lessonCount:       d.lessonCount || 0,
        estimatedDuration: d.estimatedDuration || '',
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.courseAccess = async (req, res) => {
  try {
    const email = (req.query.email || '').toLowerCase().trim();
    if (!email) {
      return res.status(400).json({ success: false, message: 'email query parameter is required' });
    }
    const purchases = await CoursePurchase.find({ email }).sort({ createdAt: -1 });
    res.json({
      success: true,
      email,
      courses: purchases.map(p => ({
        courseId:    p.courseId,
        courseTitle: p.courseTitle,
        purchasedAt: p.createdAt,
        free:        p.free,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── RP credit from CSkillsHub ───────────────────────────────────────────────
// CSkillsHub's own RP (earned there independently of anything purchased on
// Kabacu — e.g. course completion, quizzes) is pushed in here to land in the
// SAME rpBalance Kabacu's own purchases credit. Mirrors the signing
// convention server/services/bittokenService.js already uses for the
// opposite direction (Kabacu -> BitToken): HMAC-SHA256 over a pipe-joined
// payload, with its own dedicated shared secret rather than reusing
// BitToken's — a leaked secret should only ever compromise one integration.
const RP_CREDIT_TIMESTAMP_TOLERANCE_SEC = 5 * 60;

function verifyRpCreditSignature({ email, rp_amount, reference, timestamp }, signature) {
  if (!signature || !process.env.CSKILLSHUB_RP_SHARED_SECRET) return false;
  const payload = `${email}|${rp_amount}|${reference}|${timestamp}`;
  const expected = crypto
    .createHmac('sha256', process.env.CSKILLSHUB_RP_SHARED_SECRET)
    .update(payload)
    .digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature), 'utf8');
  // Buffer.compare/timingSafeEqual both throw on a length mismatch rather
  // than just returning false, so that case has to be caught explicitly —
  // a forged short signature must not 500 instead of cleanly 401-ing.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

exports.creditRp = async (req, res) => {
  try {
    const body = req.body || {};
    const email     = String(body.email || '').toLowerCase().trim();
    const rpAmount  = Number(body.rp_amount);
    const reference = String(body.reference || '').trim();
    const timestamp = Number(body.timestamp);
    const signature = req.headers['x-signature'];

    if (!email || !reference || !Number.isFinite(rpAmount) || rpAmount <= 0 || !Number.isFinite(timestamp)) {
      return res.status(400).json({
        success: false,
        message: 'email, rp_amount (a positive number), reference, and timestamp are all required',
      });
    }

    // Reject anything signed too long ago (a leaked/sniffed payload being
    // replayed) or implausibly far in the future (clock skew gone wrong).
    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - timestamp) > RP_CREDIT_TIMESTAMP_TOLERANCE_SEC) {
      return res.status(401).json({ success: false, message: 'Request timestamp outside the allowed window' });
    }

    if (!verifyRpCreditSignature({ email, rp_amount: body.rp_amount, reference, timestamp: body.timestamp }, signature)) {
      return res.status(401).json({ success: false, message: 'Invalid signature' });
    }

    const user = await User.findOne({ email }).select('_id rpBalance');
    if (!user) {
      return res.status(404).json({ success: false, message: 'No Kabacu account exists for that email' });
    }

    // Claim the reference before touching any balance. A unique-index
    // collision means CSkillsHub already sent this exact event before (a
    // retried webhook, a network timeout that actually succeeded, etc.) —
    // report the prior outcome rather than crediting RP a second time.
    let ledgerRow;
    try {
      ledgerRow = await ExternalRpCredit.create({
        source: 'cskillshub',
        reference,
        user: user._id,
        email,
        rpAmount,
        courseId: body.course_id || null,
        courseTitle: body.course_title || '',
        reason: body.reason || '',
        rawPayload: body,
      });
    } catch (err) {
      if (err && err.code === 11000) {
        const existing = await ExternalRpCredit.findOne({ source: 'cskillshub', reference });
        return res.json({
          success: true,
          message: 'Already processed — no additional RP credited',
          rpCredited: existing ? existing.rpAmount : 0,
          newBalance: existing ? existing.balanceAfter : undefined,
        });
      }
      throw err;
    }

    // Atomic increment; new:false hands back the pre-update document, the
    // only race-free way to know the true before-balance — same pattern the
    // PalmPay webhook uses for the same reason.
    const beforeDoc = await User.findOneAndUpdate(
      { _id: user._id },
      { $inc: { rpBalance: rpAmount } },
      { new: false, select: 'rpBalance' }
    );
    const balanceBefore = (beforeDoc && beforeDoc.rpBalance) || 0;
    const balanceAfter = balanceBefore + rpAmount;

    ledgerRow.balanceBefore = balanceBefore;
    ledgerRow.balanceAfter = balanceAfter;
    await ledgerRow.save();

    return res.json({
      success: true,
      message: 'RP credited',
      rpCredited: rpAmount,
      newBalance: balanceAfter,
    });
  } catch (err) {
    console.error('[creditRp]', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};
