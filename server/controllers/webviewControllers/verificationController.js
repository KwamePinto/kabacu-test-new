/**
 * WhatsApp verification and the signup-bonus progress page.
 *
 * Split out of userController rather than added to it: that file is already
 * ~1200 lines and owns password/session concerns, while everything here is
 * about earning a promotion.
 */
const User = require('../../models/UserModel');
const Beneficiary = require('../../models/BeneficiaryModel');
const referralService = require('../../services/referralService');
const wa = require('../../services/whatsapp');
const logger = require('../../config/logger');
const { authenticateUser } = require('../../config/authMiddleware');
const { toCode } = require('../../utils/country');

/* ── WhatsApp verification ─────────────────────────────────────────────── */

exports.verifyWhatsappPage = [
  authenticateUser,
  async (req, res) => {
    const user = await User.findById(req.user.id)
      .select('whatsappVerifiedAt whatsappNumber whatsappLocalNumber whatsappTokenExpires country')
      .lean();

    // A pending code that has not expired means they were mid-flow, so the
    // page opens on the code step instead of asking for the number again.
    const pending = Boolean(
      user && user.whatsappTokenExpires && new Date(user.whatsappTokenExpires) > new Date(),
    );

    /* Default the picker to the account's own country rather than assuming
       Nigeria — Ghana is a live market and users span many more. `country`
       is stored as a lowercase name ("ghana"), so it needs converting. */
    const defaultCountry = toCode(user && user.country) || 'NG';

    res.render('webview/verify-whatsapp', {
      title: 'Verify your WhatsApp',
      verified: Boolean(user && user.whatsappVerifiedAt),
      /* Show whatever we hold: the local form for Nigeria, otherwise the
         international one, since non-Nigerian numbers have no local form. */
      currentNumber: (user && (user.whatsappLocalNumber || user.whatsappNumber)) || '',
      pending,
      configured: wa.isConfigured(),
      /* Only Nigerian numbers become beneficiaries, so the page must not
         promise that to a Ghanaian user. */
      isBeneficiary: Boolean(user && user.whatsappLocalNumber),
      countries: wa.countryDialList(),
      defaultCountry,
      hideHeader: true,
      hideFooter: true,
    });
  },
];

exports.sendWhatsappCode = [
  authenticateUser,
  async (req, res) => {
    try {
      if (!wa.isConfigured()) {
        return res.json({ success: false, message: 'WhatsApp verification is not set up yet. Please try again later.' });
      }

      const user = await User.findById(req.user.id);
      if (!user) return res.json({ success: false, message: 'Account not found.' });

      /* The country the picker was on, falling back to the account's own.
         It only matters for numbers typed in local form — an explicit
         +prefix is self-describing and wins regardless. */
      const country = String(req.body.country || '').toUpperCase() || toCode(user.country) || 'NG';
      const parsed = wa.normalizePhone(req.body.phone, country);
      if (!parsed) {
        return res.json({
          success: false,
          message: 'That does not look like a mobile number. Check the country and try again.',
        });
      }

      if (user.whatsappVerifiedAt && user.whatsappNumber === parsed.e164) {
        return res.json({ success: false, message: 'That number is already verified on your account.' });
      }

      /* One account per verified number — this is what stops the bonus being
         farmed with a single phone. Checked before sending so the user is not
         charged a message to learn it will not work. */
      const taken = await User.findOne({
        whatsappNumber: parsed.e164,
        whatsappVerifiedAt: { $ne: null },
        _id: { $ne: user._id },
      }).select('_id').lean();
      if (taken) {
        return res.json({
          success: false,
          message: 'That number is already verified on another account. Each number can only be used once.',
        });
      }

      const allowance = wa.checkSendAllowance(user);
      if (!allowance.ok) return res.json({ success: false, message: allowance.message });

      const code = wa.generateCode();

      // Stored before the send, so a message that arrives while the response
      // is still in flight can already be verified.
      user.whatsappNumber = parsed.e164;
      // Null for every country but Nigeria — see normalizePhone.
      user.whatsappLocalNumber = parsed.local;
      user.whatsappToken = wa.hashCode(code);
      user.whatsappTokenExpires = new Date(Date.now() + wa.CODE_TTL_MS);
      user.whatsappSendCount = allowance.nextCount;
      user.whatsappLastSentAt = new Date();
      user.whatsappTries = 0;
      await user.save();

      try {
        await wa.sendCode(parsed.e164, code);
      } catch (sendErr) {
        // Clear the pending code: leaving one behind would let the next screen
        // ask for a code that was never delivered.
        user.whatsappToken = null;
        user.whatsappTokenExpires = null;
        await user.save();
        return res.json({ success: false, message: sendErr.message });
      }

      const shown = parsed.local || parsed.e164;
      const masked = shown.slice(0, 4) + '****' + shown.slice(-3);
      return res.json({ success: true, message: `Code sent to ${masked} on WhatsApp.`, masked });
    } catch (err) {
      // A duplicate-key error can still surface if two accounts race the same
      // number between the check above and the save.
      if (err && err.code === 11000) {
        return res.json({ success: false, message: 'That number is already in use on another account.' });
      }
      logger.error(`[WHATSAPP send] ${err.message}`);
      return res.json({ success: false, message: 'Something went wrong. Please try again.' });
    }
  },
];

exports.verifyWhatsappCode = [
  authenticateUser,
  async (req, res) => {
    try {
      const code = String(req.body.code || '').replace(/\D/g, '');
      if (code.length !== 6) {
        return res.json({ success: false, message: 'Enter the 6-digit code from WhatsApp.' });
      }

      const user = await User.findById(req.user.id);
      if (!user) return res.json({ success: false, message: 'Account not found.' });

      if (user.whatsappVerifiedAt) {
        return res.json({ success: true, message: 'Your WhatsApp number is already verified.', alreadyDone: true });
      }
      if (!user.whatsappToken || !user.whatsappTokenExpires) {
        return res.json({ success: false, message: 'Request a code first.' });
      }
      if (new Date(user.whatsappTokenExpires) <= new Date()) {
        return res.json({ success: false, message: 'That code has expired. Request a new one.' });
      }
      if ((user.whatsappTries || 0) >= wa.MAX_TRIES) {
        return res.json({ success: false, message: 'Too many incorrect attempts. Request a new code.' });
      }

      if (wa.hashCode(code) !== user.whatsappToken) {
        user.whatsappTries = (user.whatsappTries || 0) + 1;
        await user.save();
        const left = Math.max(0, wa.MAX_TRIES - user.whatsappTries);
        return res.json({
          success: false,
          message: left ? `Incorrect code. ${left} attempt${left === 1 ? '' : 's'} left.` : 'Incorrect code. Request a new one.',
        });
      }

      user.whatsappVerifiedAt = new Date();
      user.whatsappToken = null;
      user.whatsappTokenExpires = null;
      user.whatsappTries = 0;
      await user.save();

      /* The whole point of verifying a number the user owns is that we can
         then offer it back to them. Saved as a beneficiary so buying data for
         their own line is one tap, which is what the existing beneficiary
         chips on the buy modal already read from. */
      let beneficiarySaved = false;
      /* Only for Nigerian numbers. Every data product is Nigerian, so
         offering a Ghanaian line as a beneficiary would put a number in the
         buy sheet that no bundle can be delivered to — and the beneficiary
         validator expects the 11-digit Nigerian form anyway. */
      try {
        if (user.whatsappLocalNumber) {
          const existing = await Beneficiary.findOne({
            user: user._id,
            phone: user.whatsappLocalNumber,
            is_deleted: 0,
          }).select('_id').lean();
          if (!existing) {
            await Beneficiary.create({
              user: user._id,
              phone: user.whatsappLocalNumber,
              nickname: 'My WhatsApp',
            });
            beneficiarySaved = true;
          }
        }
      } catch (benErr) {
        // Never fail the verification over a convenience record.
        logger.error(`[WHATSAPP verify] beneficiary save failed: ${benErr.message}`);
      }

      logger.info(`[WHATSAPP] ${user.email} verified ${user.whatsappLocalNumber || user.whatsappNumber}`);
      return res.json({
        success: true,
        message: beneficiarySaved
          ? 'WhatsApp verified, and saved as a beneficiary for data purchases.'
          : 'WhatsApp verified.',
      });
    } catch (err) {
      logger.error(`[WHATSAPP verify] ${err.message}`);
      return res.json({ success: false, message: 'Something went wrong. Please try again.' });
    }
  },
];

/* ── Signup bonus progress ─────────────────────────────────────────────── */

exports.signupBonusPage = [
  authenticateUser,
  async (req, res) => {
    try {
      const progress = await referralService.signupBonusProgress(req.user.id);
      if (!progress) return res.redirect('/user-profile');

      res.render('webview/signup-bonus', {
        title: 'Signup bonus',
        progress,
      });
    } catch (err) {
      logger.error(`[SIGNUP BONUS page] ${err.message}`);
      req.flash('error', 'Could not load your bonus progress. Please try again.');
      return res.redirect('/user-profile');
    }
  },
];

exports.claimSignupBonus = [
  authenticateUser,
  async (req, res) => {
    try {
      const result = await referralService.claimSignupBonus(req.user.id);
      if (!result.success) return res.json(result);

      const { type, amount } = result.reward;
      const label = type === 'rewardpoint' ? `${amount} RP`
        : type === 'money' ? `₦${Number(amount).toLocaleString()}`
        : `${amount} ${type}`;

      return res.json({ success: true, message: `${label} added to your account.`, label });
    } catch (err) {
      logger.error(`[SIGNUP BONUS claim] ${err.message}`);
      return res.json({ success: false, message: 'Something went wrong. Please try again.' });
    }
  },
];

// Cosmetic only: hides the "finish setting up your account" banner.
exports.dismissSetupBanner = [
  authenticateUser,
  async (req, res) => {
    try {
      await User.updateOne({ _id: req.user.id }, { $set: { setupBannerDismissedAt: new Date() } });
      return res.json({ success: true });
    } catch (err) {
      return res.json({ success: false });
    }
  },
];
