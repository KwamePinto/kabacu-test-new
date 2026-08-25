const bcrypt = require('bcrypt')
const saltRounds = 10;
const validator = require('validator')
const countries = require("i18n-iso-countries");

const UserModel = require('../../models/UserModel');
const {generateUserToken} = require('../../config/authUtils');
const sendEmail = require('../../utils/emailService');
const referralService = require('../../services/referralService');
const { resolveLoginCountry, setWalletCountry, toCode, DEFAULT_COUNTRY } = require('../../utils/country');

exports.login = async (req, res) => {
    const a = Math.floor(Math.random() * 9) + 1;
    const b = Math.floor(Math.random() * 9) + 1;
    const ops = [
        { sym: '+', answer: a + b },
        { sym: '−', answer: Math.max(a, b) - Math.min(a, b), x: Math.max(a, b), y: Math.min(a, b) },
        { sym: '×', answer: a * b }
    ];
    const op = ops[Math.floor(Math.random() * ops.length)];
    const x = op.x !== undefined ? op.x : a;
    const y = op.y !== undefined ? op.y : b;
    req.session.mathCaptchaAnswer = op.answer;
    res.render('webview/login', { hideHeader: true, hideFooter: true, mathQuestion: `${x} ${op.sym} ${y}` });
}

exports.loginPost = async (req,res)=>{
    
  try {

        let {

            email,
            password

        } = req.body;

        // =====================================
        // SANITIZE INPUTS
        // =====================================

        email =
            email?.trim().toLowerCase();

        password =
            password?.trim();

        // =====================================
        // MATH CAPTCHA VALIDATION
        // =====================================

        const mathAnswer = parseInt(req.body.mathAnswer, 10);
        const expectedAnswer = req.session.mathCaptchaAnswer;
        req.session.mathCaptchaAnswer = null;

        if (isNaN(mathAnswer) || mathAnswer !== expectedAnswer) {
            req.flash('error', 'Incorrect answer to the math question. Please try again.');
            return res.redirect('/user/login');
        }

        // =====================================
        // REQUIRED VALIDATION
        // =====================================

        if (

            !email ||

            !password

        ) {

            req.flash(
                'error',
                'All fields are required'
            );

            return res.redirect(
                '/user/login'
            );
        }

        // =====================================
        // EMAIL VALIDATION
        // =====================================

        if (

            !validator.isEmail(email)

        ) {

            req.flash(
                'error',
                'Invalid email address'
            );

            return res.redirect(
                '/user/login'
            );
        }

        // =====================================
        // FIND USER
        // =====================================

        const user =
            await UserModel.findOne({

                email
            });

        // =====================================
        // USER NOT FOUND
        // =====================================

        if (!user) {

            req.flash(
                'error',
                'Account not found. Please signup'
            );

            return res.redirect(
                '/user/login'
            );
        }

        // =====================================
        // CHECK PASSWORD
        // =====================================

        const isPasswordValid =
            await bcrypt.compare(

                password,
                user.password
            );

        if (!isPasswordValid) {

            req.flash(
                'error',
                'Invalid email or password'
            );

            return res.redirect(
                '/user/login'
            );
        }

        // =====================================
        // CHECK IF EMAIL IS VERIFIED
        // =====================================
        if (user.isVerified === false) {
            req.session.pendingVerificationEmail = email;
            req.flash('error', 'Your email is not verified yet. Please enter the OTP code sent to your email.');
            return res.redirect('/user/verify-otp');
        }

        // =====================================
        // GENERATE TOKEN
        // =====================================

        const token =
            generateUserToken(user);

        // =====================================
        // SAVE COOKIE
        // =====================================

        res.cookie(

            'user_token',

            token,

            {

                httpOnly: true,

                secure:
                    process.env.NODE_ENV
                    === 'production',

                sameSite: 'lax',

                maxAge:
                    24 * 60 * 60 * 1000
            }
        );

        // =====================================
        // LANDING MARKET
        // =====================================

        // Where they land is their registration country if we have actually
        // launched there, and Nigeria otherwise — a user who registered in a
        // country we do not serve gets a working store rather than an empty
        // one. Switching away afterwards is their choice, and that is when
        // "coming soon" is the honest thing to show them.
        try {
            const landing = await resolveLoginCountry(user);

            res.cookie('kbc_country', landing, {
                maxAge: 365 * 24 * 60 * 60 * 1000,
                sameSite: 'lax',
                // Read by the header script, so not httpOnly.
                httpOnly: false,
            });

            // Point their money at that market too, but only if it has a
            // wallet: resolveLoginCountry accepts a market that merely has
            // products, and there is no money to hold in one of those.
            await setWalletCountry(user._id, landing);
        } catch (marketErr) {
            // Never block a login on this. Without the cookie they fall back to
            // their profile country on the next request, which is the same
            // answer in every case except an unlaunched market.
            console.log('LOGIN MARKET RESOLVE:', marketErr.message);
        }

        // =====================================
        // SUCCESS LOGIN
        // =====================================

        req.flash(
            'success',
            'Login successful'
        );

        return res.redirect('/');

    } catch (error) {

        console.log(
            'LOGIN ERROR:',
            error
        );

        req.flash(
            'error',
            'Something went wrong'
        );

        return res.redirect(
            '/user/login'
        );
    }
   


}

exports.signup = async (req,res)=>{
    countries.registerLocale(
  require("i18n-iso-countries/langs/en.json")
);

const countryNames = countries.getNames("en");

/**
 * Which wallet a brand-new account starts on.
 *
 * Narrower than resolveLoginCountry on purpose: that decides which *products*
 * they see and accepts a market with products but no wallet. This decides where
 * their *money* lives, so it accepts only a market with a live wallet.
 */
async function resolveSignupWalletCountry(countryValue) {
    try {
        const code = toCode(countryValue);
        if (!code || code === DEFAULT_COUNTRY) return DEFAULT_COUNTRY;
        const CountryWallet = require('../../models/CountryWalletModel');
        const wallet = await CountryWallet
            .findOne({ country: code, isActive: true })
            .select('_id')
            .lean();
        return wallet ? code : DEFAULT_COUNTRY;
    } catch (err) {
        // Never block a signup on this. Nigeria is the safe answer.
        console.log('SIGNUP WALLET COUNTRY:', err.message);
        return DEFAULT_COUNTRY;
    }
}


    const a = Math.floor(Math.random() * 9) + 1;
    const b = Math.floor(Math.random() * 9) + 1;
    const ops = [
        { sym: '+', answer: a + b },
        { sym: '−', answer: Math.max(a, b) - Math.min(a, b), x: Math.max(a, b), y: Math.min(a, b) },
        { sym: '×', answer: a * b }
    ];
    const op = ops[Math.floor(Math.random() * ops.length)];
    const x = op.x !== undefined ? op.x : a;
    const y = op.y !== undefined ? op.y : b;
    req.session.signupMathCaptcha = op.answer;

    res.render('webview/register', { countryNames, hideHeader: true, hideFooter: true, mathQuestion: `${x} ${op.sym} ${y}` })

}



exports.signupPost =
async (req, res) => {

    try {

        let {

            username,
            email,
            phone_number,
            minerId,
            password,
            country

        } = req.body;

        // =====================================
        // SANITIZE INPUTS
        // =====================================

        username =
            username?.trim();

        email =
            email?.trim().toLowerCase();

        minerId =
            minerId?.trim();

        password =
            password?.trim();

        country =
            country?.trim().toLowerCase();

        // =====================================
        // MATH CAPTCHA VALIDATION
        // =====================================

        const mathAnswer = parseInt(req.body.mathAnswer, 10);
        const expectedAnswer = req.session.signupMathCaptcha;
        req.session.signupMathCaptcha = null;

        if (isNaN(mathAnswer) || mathAnswer !== expectedAnswer) {
            req.flash('error', 'Incorrect answer to the math question. Please try again.');
            return res.redirect('/user/signup');
        }

        // =====================================
        // REQUIRED FIELD VALIDATION
        // =====================================

        if (

            !username ||

            !email ||

            !password ||

            !country

        ) {

            req.flash(
                'error',
                'All required fields must be filled'
            );

            return res.redirect(
                '/user/signup'
            );
        }

        // =====================================
        // USERNAME VALIDATION
        // =====================================

        if (username.length < 3) {

            req.flash(
                'error',
                'Username must be at least 3 characters'
            );

            return res.redirect(
                '/user/signup'
            );
        }

        // =====================================
        // EMAIL VALIDATION
        // =====================================

        if (

            !validator.isEmail(email)

        ) {

            req.flash(
                'error',
                'Invalid email address'
            );

            return res.redirect(
                '/user/signup'
            );
        }

        // =====================================
        // PASSWORD VALIDATION
        // =====================================

        if (password.length < 6) {

            req.flash(
                'error',
                'Password must be at least 6 characters'
            );

            return res.redirect(
                '/user/signup'
            );
        }

        // =====================================
        // COUNTRY VALIDATION
        // =====================================

        // const allowedCountries = [

        //     'ghana',
        //     'nigeria'
        // ];

        // if (

        //     !allowedCountries.includes(country)

        // ) {

        //     req.flash(
        //         'error',
        //         'Invalid country selected'
        //     );

        //     return res.redirect(
        //         '/user/signup'
        //     );
        // }

        // =====================================
        // CHECK EXISTING EMAIL
        // =====================================

        const existingEmail =
            await UserModel.findOne({

                email
            });

        if (existingEmail) {

            req.flash(
                'error',
                'Email already exists'
            );

            return res.redirect(
                '/user/signup'
            );
        }

        // =====================================
        // CHECK MINER ID
        // =====================================

        let parsedMinerId = null;
        if (minerId) {
            const isNum = /^\d+$/.test(minerId);
            if (!isNum || minerId.length > 11) {
                req.flash(
                    'error',
                    'Miner ID must be a number with a maximum of 11 digits'
                );

                return res.redirect(
                    '/user/signup'
                );
            }
            parsedMinerId = Number(minerId);

            const existingMinerId =
                await UserModel.findOne({
                    minerId: parsedMinerId
                });

            if (existingMinerId) {

                req.flash(
                    'error',
                    'Miner ID already taken'
                );

                return res.redirect(
                    '/user/signup'
                );
            }
        }

        // =====================================
        // HASH PASSWORD
        // =====================================

        const hashedPassword =
            await bcrypt.hash(

                password,
                saltRounds
            );

        // =====================================
        // GENERATE OTP & CREATE UNVERIFIED USER
        // =====================================

        const otp = Math.floor(100000 + Math.random() * 900000).toString();

        await UserModel.create({

            username,

            email,
            phone_number,

            minerId:
                parsedMinerId,

            country,

            /* Point their money at the market they registered in, but only if
               we hold money there — otherwise Nigeria. Their `country` is kept
               as given either way: it is where they said they are, which is not
               the same question as which wallet they can spend from. */
            walletCountry:
                await resolveSignupWalletCountry(country),

            role: 'users',

            password:
                hashedPassword,

            isVerified: false,
            verificationToken: otp,
            verificationTokenExpires: Date.now() + 15 * 60 * 1000
        });

        req.session.pendingVerificationEmail = email;

        // =====================================
        // SEND OTP EMAIL (non-fatal)
        // =====================================

        try {
          await sendEmail({
  to: email,
  subject: 'Verify Your Email – OTP Code',
  html: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Email Verification</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f7f6;font-family:'Inter',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f7f6;padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.07);">

          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#15a844 0%,#0e7a31 100%);padding:36px 40px;text-align:center;">
              <h1 style="margin:0;color:#ffffff;font-size:26px;font-weight:700;letter-spacing:-0.5px;">Kabacu</h1>
              <p style="margin:6px 0 0;color:rgba(255,255,255,0.8);font-size:13px;font-weight:400;">Your trusted marketplace</p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:40px 40px 32px;">
              <h2 style="margin:0 0 12px;color:#1a1a2e;font-size:20px;font-weight:600;">Verify your email address</h2>
              <p style="margin:0 0 28px;color:#555;font-size:15px;line-height:1.6;">
                Thanks for signing up! Enter the code below to confirm your email and activate your account.
              </p>

              <!-- OTP Box -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center">
                    <div style="display:inline-block;background:#e8f5ee;border:2px dashed #15a844;border-radius:12px;padding:22px 48px;margin-bottom:28px;">
                      <p style="margin:0 0 4px;color:#0e7a31;font-size:11px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;">Your OTP Code</p>
                      <p style="margin:0;color:#0e7a31;font-size:40px;font-weight:800;letter-spacing:10px;line-height:1.2;">${otp}</p>
                    </div>
                  </td>
                </tr>
              </table>

              <!-- Expiry notice -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
                <tr>
                  <td style="background:#fff8ed;border-left:4px solid #f97316;border-radius:4px;padding:12px 16px;">
                    <p style="margin:0;color:#b45309;font-size:13px;">
                      &#9201;&nbsp; This code expires in <strong>15 minutes</strong>. Do not share it with anyone.
                    </p>
                  </td>
                </tr>
              </table>

              <p style="margin:0;color:#888;font-size:13px;line-height:1.6;">
                If you didn't create a Kabacu account, you can safely ignore this email.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#f9fafb;border-top:1px solid #ebebeb;padding:20px 40px;text-align:center;">
              <p style="margin:0;color:#aaa;font-size:12px;line-height:1.6;">
                &copy; ${new Date().getFullYear()} Kabacu. All rights reserved.<br/>
                This is an automated message — please do not reply.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
          });
        } catch (emailErr) {
            console.error('SIGNUP OTP EMAIL ERROR:', emailErr.message || emailErr);
            req.flash('error', 'Account created but we could not send the verification email. Use Resend Code on the next page.');
        }

        // =====================================
        // SUCCESS
        // =====================================

        req.flash(
            'success',
            'Registration successful! Please enter the OTP code sent to your email.'
        );

        return res.redirect(
            '/user/verify-otp'
        );

    } catch (error) {

        console.log('SIGNUP ERROR:', error);

        req.flash(
            'error',
            'Something went wrong during registration. Please try again.'
        );

        return res.redirect(
            '/user/signup'
        );
    }
};

exports.logout = (req, res) => {
    res.clearCookie('user_token')
    res.redirect('/')
}

exports.refreshCaptcha = (req, res) => {
    const { type } = req.query;
    const a = Math.floor(Math.random() * 9) + 1;
    const b = Math.floor(Math.random() * 9) + 1;
    const ops = [
        { sym: '+', answer: a + b },
        { sym: '−', answer: Math.max(a, b) - Math.min(a, b), x: Math.max(a, b), y: Math.min(a, b) },
        { sym: '×', answer: a * b }
    ];
    const op = ops[Math.floor(Math.random() * ops.length)];
    const x = op.x !== undefined ? op.x : a;
    const y = op.y !== undefined ? op.y : b;

    if (type === 'signup') {
        req.session.signupMathCaptcha = op.answer;
    } else {
        req.session.mathCaptchaAnswer = op.answer;
    }

    res.json({ question: `${x} ${op.sym} ${y}` });
};

exports.resetPassword = async (req, res) => {
  res.render('webview/reset-password', { hideHeader: true, hideFooter: true });
};

exports.resetPasswordPost = async (req, res) => {
  try {
    let { email, currentPassword, newPassword, confirmPassword } = req.body;

    email           = email?.trim().toLowerCase();
    currentPassword = currentPassword?.trim();
    newPassword     = newPassword?.trim();
    confirmPassword = confirmPassword?.trim();

    if (!email || !currentPassword || !newPassword || !confirmPassword) {
      req.flash('error', 'All fields are required');
      return res.redirect('/user/reset-password');
    }

    if (!validator.isEmail(email)) {
      req.flash('error', 'Invalid email address');
      return res.redirect('/user/reset-password');
    }

    if (newPassword.length < 6) {
      req.flash('error', 'New password must be at least 6 characters');
      return res.redirect('/user/reset-password');
    }

    if (newPassword !== confirmPassword) {
      req.flash('error', 'New passwords do not match');
      return res.redirect('/user/reset-password');
    }

    const user = await UserModel.findOne({ email });
    if (!user) {
      req.flash('error', 'No account found with that email address');
      return res.redirect('/user/reset-password');
    }

    const isValid = await bcrypt.compare(currentPassword, user.password);
    if (!isValid) {
      req.flash('error', 'Current password is incorrect');
      return res.redirect('/user/reset-password');
    }

    user.password = await bcrypt.hash(newPassword, saltRounds);
    await user.save();

    req.flash('success', 'Password updated successfully. Please sign in with your new password.');
    return res.redirect('/user/login');

  } catch (error) {
    console.log('RESET PASSWORD ERROR:', error);
    req.flash('error', 'Something went wrong. Please try again.');
    return res.redirect('/user/reset-password');
  }
};

exports.verifyOTP = async (req, res) => {
  const email = req.session.pendingVerificationEmail;
  if (!email) {
    req.flash('error', 'No pending verification. Please register first.');
    return res.redirect('/user/signup');
  }
  res.render('webview/otp', { email, hideHeader: true, hideFooter: true });
};

exports.verifyOTPPost = async (req, res) => {
  try {
    const email = req.session.pendingVerificationEmail;
    if (!email) {
      req.flash('error', 'No pending verification. Please register first.');
      return res.redirect('/user/signup');
    }

    const { otp } = req.body;
    if (!otp) {
      req.flash('error', 'OTP is required');
      return res.redirect('/user/verify-otp');
    }

    const user = await UserModel.findOne({
      email,
      verificationToken: otp,
      verificationTokenExpires: { $gt: Date.now() }
    });

    if (!user) {
      req.flash('error', 'Invalid or expired OTP code.');
      return res.redirect('/user/verify-otp');
    }

    user.isVerified = true;
    user.verificationToken = undefined;
    user.verificationTokenExpires = undefined;
    await user.save();

    delete req.session.pendingVerificationEmail;

    // Signup-bonus promotion. Paid here rather than at signup so a working
    // inbox is proven first — otherwise the bonus can be farmed with throwaway
    // addresses. Idempotent, and never blocks verification if it fails.
    const bonus = await referralService.grantSignupBonus(user._id);
    if (bonus) {
      const label = bonus.type === 'money'
        ? `₦${bonus.amount.toLocaleString()}`
        : `${bonus.amount} RP`;
      req.flash('success', `Email verified! Your ${label} signup bonus has been added. Please log in.`);
      return res.redirect('/user/login');
    }

    req.flash('success', 'Email verified successfully! Please log in.');
    return res.redirect('/user/login');

  } catch (error) {
    console.error('VERIFY OTP ERROR:', error);
    req.flash('error', 'Something went wrong. Please try again.');
    return res.redirect('/user/verify-otp');
  }
};

// =============================================
// FORGOT PASSWORD FLOW
// =============================================

exports.forgotPassword = (req, res) => {
  res.render('webview/forgot-password', { hideHeader: true, hideFooter: true });
};

exports.forgotPasswordPost = async (req, res) => {
  try {
    let { email } = req.body;
    email = email?.trim().toLowerCase();

    if (!email || !validator.isEmail(email)) {
      req.flash('error', 'Please enter a valid email address');
      return res.redirect('/user/forgot-password');
    }

    const user = await UserModel.findOne({ email });
    if (!user) {
      req.flash('error', 'No account found with that email address');
      return res.redirect('/user/forgot-password');
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    user.forgotPasswordToken = otp;
    user.forgotPasswordTokenExpires = Date.now() + 15 * 60 * 1000;
    await user.save();

    req.session.forgotPasswordEmail = email;

    await sendEmail({
      to: email,
      subject: 'Reset Your Password – OTP Code',
      html: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Password Reset</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f7f6;font-family:'Inter',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f7f6;padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.07);">

          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#15a844 0%,#0e7a31 100%);padding:36px 40px;text-align:center;">
              <h1 style="margin:0;color:#ffffff;font-size:26px;font-weight:700;letter-spacing:-0.5px;">Kabacu</h1>
              <p style="margin:6px 0 0;color:rgba(255,255,255,0.8);font-size:13px;">Your trusted marketplace</p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:40px 40px 32px;">
              <h2 style="margin:0 0 12px;color:#1a1a2e;font-size:20px;font-weight:600;">Password reset request</h2>
              <p style="margin:0 0 28px;color:#555;font-size:15px;line-height:1.6;">
                We received a request to reset your password. Use the code below to continue. If you didn't request this, ignore this email.
              </p>

              <!-- OTP Box -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center">
                    <div style="display:inline-block;background:#e8f5ee;border:2px dashed #15a844;border-radius:12px;padding:22px 48px;margin-bottom:28px;">
                      <p style="margin:0 0 4px;color:#0e7a31;font-size:11px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;">Reset Code</p>
                      <p style="margin:0;color:#0e7a31;font-size:40px;font-weight:800;letter-spacing:10px;line-height:1.2;">\ ${otp}</p>
                    </div>
                  </td>
                </tr>
              </table>

              <!-- Expiry notice -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
                <tr>
                  <td style="background:#fff8ed;border-left:4px solid #f97316;border-radius:4px;padding:12px 16px;">
                    <p style="margin:0;color:#b45309;font-size:13px;">
                      &#9201;&nbsp; This code expires in <strong>15 minutes</strong>. Do not share it with anyone.
                    </p>
                  </td>
                </tr>
              </table>

              <p style="margin:0;color:#888;font-size:13px;line-height:1.6;">
                If you didn't request a password reset, your account is still secure — no action needed.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#f9fafb;border-top:1px solid #ebebeb;padding:20px 40px;text-align:center;">
              <p style="margin:0;color:#aaa;font-size:12px;line-height:1.6;">
                &copy; ${new Date().getFullYear()} Kabacu. All rights reserved.<br/>
                This is an automated message — please do not reply.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
    });

    req.flash('success', 'A reset code has been sent to your email.');
    return res.redirect('/user/forgot-password-otp');

  } catch (error) {
    console.error('FORGOT PASSWORD ERROR:', error);
    req.flash('error', 'Something went wrong. Please try again.');
    return res.redirect('/user/forgot-password');
  }
};

exports.forgotPasswordOTP = (req, res) => {
  const email = req.session.forgotPasswordEmail;
  if (!email) {
    req.flash('error', 'Please start the password reset process again.');
    return res.redirect('/user/forgot-password');
  }
  res.render('webview/forgot-password-otp', { email, hideHeader: true, hideFooter: true });
};

exports.forgotPasswordOTPPost = async (req, res) => {
  try {
    const email = req.session.forgotPasswordEmail;
    if (!email) {
      req.flash('error', 'Session expired. Please start again.');
      return res.redirect('/user/forgot-password');
    }

    const { otp } = req.body;
    if (!otp) {
      req.flash('error', 'OTP is required');
      return res.redirect('/user/forgot-password-otp');
    }

    const user = await UserModel.findOne({
      email,
      forgotPasswordToken: otp,
      forgotPasswordTokenExpires: { $gt: Date.now() }
    });

    if (!user) {
      req.flash('error', 'Invalid or expired reset code.');
      return res.redirect('/user/forgot-password-otp');
    }

    user.forgotPasswordToken = undefined;
    user.forgotPasswordTokenExpires = undefined;
    await user.save();

    req.session.forgotPasswordVerified = true;

    req.flash('success', 'Code verified! Please set your new password.');
    return res.redirect('/user/forgot-password-reset');

  } catch (error) {
    console.error('FORGOT PASSWORD OTP ERROR:', error);
    req.flash('error', 'Something went wrong. Please try again.');
    return res.redirect('/user/forgot-password-otp');
  }
};

exports.forgotPasswordReset = (req, res) => {
  if (!req.session.forgotPasswordEmail || !req.session.forgotPasswordVerified) {
    req.flash('error', 'Please complete the password reset process from the beginning.');
    return res.redirect('/user/forgot-password');
  }
  res.render('webview/forgot-password-reset', { hideHeader: true, hideFooter: true });
};

exports.forgotPasswordResetPost = async (req, res) => {
  try {
    if (!req.session.forgotPasswordEmail || !req.session.forgotPasswordVerified) {
      req.flash('error', 'Session expired. Please start again.');
      return res.redirect('/user/forgot-password');
    }

    let { newPassword, confirmPassword } = req.body;
    newPassword = newPassword?.trim();
    confirmPassword = confirmPassword?.trim();

    if (!newPassword || !confirmPassword) {
      req.flash('error', 'All fields are required');
      return res.redirect('/user/forgot-password-reset');
    }

    if (newPassword.length < 6) {
      req.flash('error', 'Password must be at least 6 characters');
      return res.redirect('/user/forgot-password-reset');
    }

    if (newPassword !== confirmPassword) {
      req.flash('error', 'Passwords do not match');
      return res.redirect('/user/forgot-password-reset');
    }

    const user = await UserModel.findOne({ email: req.session.forgotPasswordEmail });
    if (!user) {
      req.flash('error', 'Account not found. Please try again.');
      return res.redirect('/user/forgot-password');
    }

    user.password = await bcrypt.hash(newPassword, saltRounds);
    await user.save();

    delete req.session.forgotPasswordEmail;
    delete req.session.forgotPasswordVerified;

    req.flash('success', 'Password reset successfully! Please sign in with your new password.');
    return res.redirect('/user/login');

  } catch (error) {
    console.error('FORGOT PASSWORD RESET ERROR:', error);
    req.flash('error', 'Something went wrong. Please try again.');
    return res.redirect('/user/forgot-password-reset');
  }
};

exports.resendOTP = async (req, res) => {
  try {
    const email = req.session.pendingVerificationEmail;
    if (!email) {
      req.flash('error', 'No pending verification. Please register first.');
      return res.redirect('/user/signup');
    }

    const user = await UserModel.findOne({ email });
    if (!user) {
      req.flash('error', 'User not found.');
      return res.redirect('/user/signup');
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    user.verificationToken = otp;
    user.verificationTokenExpires = Date.now() + 15 * 60 * 1000;
    await user.save();

   // await emailService.sendOTP(email, otp);

    await sendEmail({
  to: email,
  subject: 'Your New OTP Code – Kabacu',
  html: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>New OTP Code</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f7f6;font-family:'Inter',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f7f6;padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.07);">

          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#15a844 0%,#0e7a31 100%);padding:36px 40px;text-align:center;">
              <h1 style="margin:0;color:#ffffff;font-size:26px;font-weight:700;letter-spacing:-0.5px;">Kabacu</h1>
              <p style="margin:6px 0 0;color:rgba(255,255,255,0.8);font-size:13px;font-weight:400;">Your trusted marketplace</p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:40px 40px 32px;">
              <h2 style="margin:0 0 12px;color:#1a1a2e;font-size:20px;font-weight:600;">Here's your new verification code</h2>
              <p style="margin:0 0 28px;color:#555;font-size:15px;line-height:1.6;">
                You requested a new OTP. Use the code below to verify your email address.
              </p>

              <!-- OTP Box -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center">
                    <div style="display:inline-block;background:#e8f5ee;border:2px dashed #15a844;border-radius:12px;padding:22px 48px;margin-bottom:28px;">
                      <p style="margin:0 0 4px;color:#0e7a31;font-size:11px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;">Your OTP Code</p>
                      <p style="margin:0;color:#0e7a31;font-size:40px;font-weight:800;letter-spacing:10px;line-height:1.2;">${otp}</p>
                    </div>
                  </td>
                </tr>
              </table>

              <!-- Expiry notice -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
                <tr>
                  <td style="background:#fff8ed;border-left:4px solid #f97316;border-radius:4px;padding:12px 16px;">
                    <p style="margin:0;color:#b45309;font-size:13px;">
                      &#9201;&nbsp; This code expires in <strong>15 minutes</strong>. Do not share it with anyone.
                    </p>
                  </td>
                </tr>
              </table>

              <p style="margin:0;color:#888;font-size:13px;line-height:1.6;">
                If you didn't request this code, please secure your account immediately.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#f9fafb;border-top:1px solid #ebebeb;padding:20px 40px;text-align:center;">
              <p style="margin:0;color:#aaa;font-size:12px;line-height:1.6;">
                &copy; ${new Date().getFullYear()} Kabacu. All rights reserved.<br/>
                This is an automated message — please do not reply.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
});

    req.flash('success', 'A new OTP code has been sent to your email.');
    return res.redirect('/user/verify-otp');

  } catch (error) {
    console.error('RESEND OTP ERROR:', error);
    req.flash('error', 'Something went wrong. Please try again.');
    return res.redirect('/user/verify-otp');
  }
};

// =============================================
// PROFILE CHANGE PASSWORD FLOW (authenticated)
// =============================================

exports.profileChangePassword = (req, res) => {
  res.render('webview/profile-change-password', {
    email: req.user.email,
    hideFooter: true,
  });
};

exports.profileChangePasswordPost = async (req, res) => {
  try {
    const user = await UserModel.findById(req.user.id);
    if (!user) {
      req.flash('error', 'Account not found.');
      return res.redirect('/user-profile');
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    user.forgotPasswordToken = otp;
    user.forgotPasswordTokenExpires = Date.now() + 15 * 60 * 1000;
    await user.save();

    req.session.profileChangePwEmail = user.email;

    await sendEmail({
      to: user.email,
      subject: 'Change Your Password – Verification Code',
      html: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Change Password</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f7f6;font-family:'Inter',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f7f6;padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.07);">

          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#15a844 0%,#0e7a31 100%);padding:36px 40px;text-align:center;">
              <h1 style="margin:0;color:#ffffff;font-size:26px;font-weight:700;letter-spacing:-0.5px;">Kabacu</h1>
              <p style="margin:6px 0 0;color:rgba(255,255,255,0.8);font-size:13px;">Your trusted marketplace</p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:40px 40px 32px;">
              <h2 style="margin:0 0 12px;color:#1a1a2e;font-size:20px;font-weight:600;">Password change request</h2>
              <p style="margin:0 0 28px;color:#555;font-size:15px;line-height:1.6;">
                You requested to change your account password. Enter the code below to confirm it's really you.
              </p>

              <!-- OTP Box -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center">
                    <div style="display:inline-block;background:#e8f5ee;border:2px dashed #15a844;border-radius:12px;padding:22px 48px;margin-bottom:28px;">
                      <p style="margin:0 0 4px;color:#0e7a31;font-size:11px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;">Verification Code</p>
                      <p style="margin:0;color:#0e7a31;font-size:40px;font-weight:800;letter-spacing:10px;line-height:1.2;">${otp}</p>
                    </div>
                  </td>
                </tr>
              </table>

              <!-- Expiry notice -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
                <tr>
                  <td style="background:#fff8ed;border-left:4px solid #f97316;border-radius:4px;padding:12px 16px;">
                    <p style="margin:0;color:#b45309;font-size:13px;">
                      &#9201;&nbsp; This code expires in <strong>15 minutes</strong>. Do not share it with anyone.
                    </p>
                  </td>
                </tr>
              </table>

              <p style="margin:0;color:#888;font-size:13px;line-height:1.6;">
                If you did not request this, your password has not been changed — you can safely ignore this email.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#f9fafb;border-top:1px solid #ebebeb;padding:20px 40px;text-align:center;">
              <p style="margin:0;color:#aaa;font-size:12px;line-height:1.6;">
                &copy; ${new Date().getFullYear()} Kabacu. All rights reserved.<br/>
                This is an automated message — please do not reply.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
    });

    req.flash('success', 'A verification code has been sent to your email.');
    return res.redirect('/user/profile-change-password-otp');

  } catch (error) {
    console.error('PROFILE CHANGE PW ERROR:', error);
    req.flash('error', 'Something went wrong. Please try again.');
    return res.redirect('/user/profile-change-password');
  }
};

exports.profileChangePasswordOTP = (req, res) => {
  if (!req.session.profileChangePwEmail) {
    req.flash('error', 'Please start the process again.');
    return res.redirect('/user/profile-change-password');
  }
  res.render('webview/profile-change-password-otp', {
    email: req.session.profileChangePwEmail,
    hideFooter: true,
  });
};

exports.profileChangePasswordOTPPost = async (req, res) => {
  try {
    const email = req.session.profileChangePwEmail;
    if (!email) {
      req.flash('error', 'Session expired. Please start again.');
      return res.redirect('/user/profile-change-password');
    }

    const { otp } = req.body;
    if (!otp) {
      req.flash('error', 'Verification code is required.');
      return res.redirect('/user/profile-change-password-otp');
    }

    const user = await UserModel.findOne({
      email,
      forgotPasswordToken: otp,
      forgotPasswordTokenExpires: { $gt: Date.now() },
    });

    if (!user) {
      req.flash('error', 'Invalid or expired code. Please try again.');
      return res.redirect('/user/profile-change-password-otp');
    }

    user.forgotPasswordToken = undefined;
    user.forgotPasswordTokenExpires = undefined;
    await user.save();

    req.session.profileChangePwVerified = true;

    req.flash('success', 'Identity confirmed! Set your new password below.');
    return res.redirect('/user/profile-change-password-new');

  } catch (error) {
    console.error('PROFILE CHANGE PW OTP ERROR:', error);
    req.flash('error', 'Something went wrong. Please try again.');
    return res.redirect('/user/profile-change-password-otp');
  }
};

exports.profileChangePasswordNew = (req, res) => {
  if (!req.session.profileChangePwEmail || !req.session.profileChangePwVerified) {
    req.flash('error', 'Please complete the verification step first.');
    return res.redirect('/user/profile-change-password');
  }
  res.render('webview/profile-change-password-new', { hideFooter: true });
};

exports.profileChangePasswordNewPost = async (req, res) => {
  try {
    if (!req.session.profileChangePwEmail || !req.session.profileChangePwVerified) {
      req.flash('error', 'Session expired. Please start again.');
      return res.redirect('/user/profile-change-password');
    }

    let { newPassword, confirmPassword } = req.body;
    newPassword = newPassword?.trim();
    confirmPassword = confirmPassword?.trim();

    if (!newPassword || !confirmPassword) {
      req.flash('error', 'Both fields are required.');
      return res.redirect('/user/profile-change-password-new');
    }

    if (newPassword.length < 6) {
      req.flash('error', 'Password must be at least 6 characters.');
      return res.redirect('/user/profile-change-password-new');
    }

    if (newPassword !== confirmPassword) {
      req.flash('error', 'Passwords do not match.');
      return res.redirect('/user/profile-change-password-new');
    }

    const user = await UserModel.findById(req.user.id);
    if (!user) {
      req.flash('error', 'Account not found.');
      return res.redirect('/user/profile-change-password');
    }

    user.password = await bcrypt.hash(newPassword, saltRounds);
    await user.save();

    delete req.session.profileChangePwEmail;
    delete req.session.profileChangePwVerified;

    req.flash('success', 'Password updated successfully!');
    return res.redirect('/user-profile');

  } catch (error) {
    console.error('PROFILE CHANGE PW NEW ERROR:', error);
    req.flash('error', 'Something went wrong. Please try again.');
    return res.redirect('/user/profile-change-password-new');
  }
};

