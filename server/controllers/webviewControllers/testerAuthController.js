/**
 * Login for KabakuNew's migration-testing portal — /command/testing.
 *
 * Deliberately email + one-time code only, no password: the whole point of
 * this collection is that a super admin controls the allowlist directly
 * (Admin → Support and Testing → Testing), so there is no credential to set
 * or forget — an email is either on the list or it isn't.
 *
 * A successful login sets req.session.tester and NOTHING else. It never
 * touches user_token or admin_token, so the tester is not "logged in" as far
 * as the real site's own auth is concerned — they meet the base site exactly
 * like a fresh anonymous visitor would, which is the point: they can then
 * exercise the site's actual signup/login flow themselves. The one thing the
 * tester session changes is whether maintenanceMiddleware lets them through
 * while maintenance mode is on — see that file and
 * SiteSettings.testingBypassMaintenanceEnabled.
 */
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const saltRounds = 10;

const Tester = require('../../models/TesterModel');
const sendEmail = require('../../utils/emailService');

const OTP_TTL_MS       = 10 * 60 * 1000;  // code lifetime — matches admin 2FA
const OTP_MAX_ATTEMPTS = 5;               // guesses before the code is burned
const OTP_RESEND_MS    = 60 * 1000;       // cooldown between sends

function generateOtp() {
  // crypto, not Math.random — this is an authentication factor.
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function testerOtpEmail({ code, minutes }) {
  return `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:32px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);">
        <tr>
          <td style="background:#111827;padding:24px 32px;text-align:center;">
            <h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:700;">Kabacu Testing Portal</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 32px 24px;">
            <p style="margin:0 0 18px;color:#374151;font-size:14px;line-height:1.7;">
              Use this code to sign in to the testing portal.
            </p>
            <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">
              <tr><td align="center">
                <div style="display:inline-block;background:#f0fdf4;border:1px dashed #15a844;border-radius:8px;padding:16px 32px;">
                  <span style="font-family:'Courier New',monospace;font-size:32px;font-weight:700;letter-spacing:.28em;color:#111827;">${code}</span>
                </div>
              </td></tr>
            </table>
            <p style="margin:0;color:#6b7280;font-size:13px;line-height:1.7;">
              It expires in <strong>${minutes} minutes</strong> and can only be used once.
            </p>
          </td>
        </tr>
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

/** Issues a fresh code, stores only its hash, and emails it. */
async function issueTesterOtp(tester) {
  const code = generateOtp();

  tester.otpCodeHash   = await bcrypt.hash(code, saltRounds);
  tester.otpExpires    = new Date(Date.now() + OTP_TTL_MS);
  tester.otpAttempts   = 0;
  tester.otpLastSentAt = new Date();
  await tester.save();

  const minutes = Math.round(OTP_TTL_MS / 60000);

  try {
    await sendEmail({
      to: tester.email,
      subject: `Your Kabacu testing portal code: ${code}`,
      html: testerOtpEmail({ code, minutes }),
      text: `Your Kabacu testing portal code is ${code}. It expires in ${minutes} minutes.`,
    });
  } catch (err) {
    // Roll back — otherwise an undelivered code sits there for 10 minutes and
    // otpLastSentAt starts a resend cooldown for a message that never sent.
    tester.otpCodeHash   = null;
    tester.otpExpires    = null;
    tester.otpAttempts   = 0;
    tester.otpLastSentAt = null;
    await tester.save().catch(() => {});
    throw err;
  }
}

/** victor@kabacu.com -> v*****r@kabacu.com */
function maskEmail(email) {
  const parts = String(email || '').split('@');
  const name = parts[0], domain = parts[1];
  if (!name || !domain) return '';
  if (name.length <= 2) return `${name[0]}*@${domain}`;
  return `${name[0]}${'*'.repeat(Math.max(1, name.length - 2))}${name[name.length - 1]}@${domain}`;
}

function renderLogin(res, opts = {}) {
  res.render('webview/testerLogin', {
    layout: 'layouts/adminLayout',
    error: opts.error || null,
    csrfToken: res.locals.csrfToken,
  });
}

function renderVerify(res, opts = {}) {
  res.render('webview/testerVerify', {
    layout: 'layouts/adminLayout',
    error: opts.error || null,
    notice: opts.notice || null,
    email: opts.email || '',
    csrfToken: res.locals.csrfToken,
  });
}

/** Completes the login: sets the tester session only, nothing customer- or admin-facing. */
function grantTesterSession(req, res, tester) {
  req.session.tester = { id: String(tester._id), email: tester.email };
  delete req.session.pendingTesterOtp;

  return req.session.save((saveErr) => {
    if (saveErr) console.error('[tester session save]', saveErr);
    return res.redirect('/');
  });
}

exports.loginPage = (req, res) => {
  // Already signed in — no point showing the email form again.
  if (req.session.tester) return res.redirect('/');
  renderLogin(res);
};

exports.loginPost = async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      return renderLogin(res, { error: 'Enter a valid email address.' });
    }

    const tester = await Tester.findOne({ email });
    if (!tester) {
      // Direct, not vague: this is a small internal allowlist a super admin
      // manages by hand, not a customer-facing login where confirming an
      // address exists would leak anything meaningful.
      return renderLogin(res, { error: 'That email is not on the testers list. Ask a super admin to add it.' });
    }

    await issueTesterOtp(tester);
    req.session.pendingTesterOtp = { id: String(tester._id), email: tester.email };

    return req.session.save((saveErr) => {
      if (saveErr) console.error('[tester pending otp session save]', saveErr);
      return res.redirect('/command/testing/verify');
    });
  } catch (err) {
    console.error('[testerAuth loginPost]', err);
    return renderLogin(res, { error: 'Could not send a code. Please try again.' });
  }
};

exports.verifyOtpPage = (req, res) => {
  const pending = req.session.pendingTesterOtp;
  if (!pending) {
    return renderLogin(res, { error: 'Your sign-in session expired. Please sign in again.' });
  }
  renderVerify(res, { email: maskEmail(pending.email) });
};

exports.verifyOtpPost = async (req, res) => {
  try {
    const pending = req.session.pendingTesterOtp;
    if (!pending) return res.redirect('/command/testing');

    const masked = maskEmail(pending.email);
    const code = String(req.body.code || '').replace(/\D/g, '');

    if (code.length !== 6) {
      return renderVerify(res, { email: masked, error: 'Enter the 6-digit code from your email.' });
    }

    const tester = await Tester.findById(pending.id);
    if (!tester) {
      delete req.session.pendingTesterOtp;
      return renderLogin(res, { error: 'Something went wrong. Please sign in again.' });
    }

    if (!tester.otpCodeHash || !tester.otpExpires) {
      return renderVerify(res, { email: masked, error: 'No active code. Request a new one.' });
    }

    if (tester.otpExpires.getTime() < Date.now()) {
      return renderVerify(res, { email: masked, error: 'That code has expired. Request a new one.' });
    }

    // Count the attempt before comparing, so a crash mid-request cannot buy a
    // free retry.
    tester.otpAttempts = (tester.otpAttempts || 0) + 1;

    if (tester.otpAttempts > OTP_MAX_ATTEMPTS) {
      // Burn the code rather than allow unlimited guesses at six digits.
      tester.otpCodeHash = null;
      tester.otpExpires  = null;
      await tester.save();
      delete req.session.pendingTesterOtp;
      return renderLogin(res, { error: 'Too many incorrect codes. Please sign in again.' });
    }

    const ok = await bcrypt.compare(code, tester.otpCodeHash);
    if (!ok) {
      await tester.save();
      const left = OTP_MAX_ATTEMPTS - tester.otpAttempts;
      const suffix = left > 0 ? ` ${left} attempt${left === 1 ? '' : 's'} left.` : '';
      return renderVerify(res, { email: masked, error: `Incorrect code.${suffix}` });
    }

    // Single use — cleared so the same code cannot be replayed.
    tester.otpCodeHash   = null;
    tester.otpExpires    = null;
    tester.otpAttempts   = 0;
    tester.lastLoginAt   = new Date();
    await tester.save();

    return grantTesterSession(req, res, tester);
  } catch (err) {
    console.error('[testerAuth verifyOtpPost]', err);
    return renderVerify(res, { error: 'Something went wrong. Please try again.' });
  }
};

exports.resendOtp = async (req, res) => {
  try {
    const pending = req.session.pendingTesterOtp;
    if (!pending) return res.redirect('/command/testing');

    const masked = maskEmail(pending.email);
    const tester = await Tester.findById(pending.id);
    if (!tester) {
      delete req.session.pendingTesterOtp;
      return renderLogin(res, { error: 'Something went wrong. Please sign in again.' });
    }

    const last = tester.otpLastSentAt ? tester.otpLastSentAt.getTime() : 0;
    const wait = OTP_RESEND_MS - (Date.now() - last);
    if (wait > 0) {
      return renderVerify(res, {
        email: masked,
        error: `Please wait ${Math.ceil(wait / 1000)}s before requesting another code.`,
      });
    }

    await issueTesterOtp(tester);
    return renderVerify(res, { email: masked, notice: 'A new code is on its way.' });
  } catch (err) {
    console.error('[testerAuth resendOtp]', err);
    return renderVerify(res, { error: 'Could not send a new code. Please try again.' });
  }
};

/** Exit testing mode — clears the tester session, nothing else. */
exports.logout = (req, res) => {
  delete req.session.tester;
  const back = req.get('Referer') || '/';
  return req.session.save(() => res.redirect(back));
};
