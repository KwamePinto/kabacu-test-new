const bcrypt = require('bcrypt');
const saltRounds = 10;
const validator = require('validator');
const UserModel = require('../../models/UserModel');
const { generateUserToken } = require('../../config/authUtils');
const emailService = require('../../utils/emailService');
const referralCodeService = require('../../services/referralCodeService');

exports.login = async (req, res) => {
  try {
    let { email, password } = req.body;

    email    = email?.trim().toLowerCase();
    password = password?.trim();

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required' });
    }

    if (!validator.isEmail(email)) {
      return res.status(400).json({ success: false, message: 'Invalid email address' });
    }

    const user = await UserModel.findOne({ email });

    if (!user) {
      return res.status(401).json({ success: false, message: 'Account not found' });
    }

    const isValid = await bcrypt.compare(password, user.password);

    if (!isValid) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    if (user.isVerified === false) {
      return res.status(403).json({ success: false, message: 'Email not verified. Please verify your email.', email, isVerified: false });
    }

    const token = generateUserToken(user);

    res.json({
      success: true,
      token,
      user: {
        id:       user._id,
        username: user.username,
        email:    user.email,
        role:     user.role,
        minerId:  user.minerId
      }
    });

  } catch (error) {
    console.log('API LOGIN ERROR:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.register = async (req, res) => {
  try {
    let { username, email, phone_number, minerId, password, country } = req.body;

    username     = username?.trim();
    email        = email?.trim().toLowerCase();
    minerId      = minerId?.trim();
    password     = password?.trim();
    country      = country?.trim().toLowerCase();
    phone_number = phone_number?.trim();

    if (!username || !email || !password || !country) {
      return res.status(400).json({ success: false, message: 'username, email, password and country are required' });
    }

    if (username.length < 3) {
      return res.status(400).json({ success: false, message: 'Username must be at least 3 characters' });
    }

    if (!validator.isEmail(email)) {
      return res.status(400).json({ success: false, message: 'Invalid email address' });
    }

    if (password.length < 8) {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
    }

    const allowedCountries = ['ghana', 'nigeria'];
    if (!allowedCountries.includes(country)) {
      return res.status(400).json({ success: false, message: 'Country must be nigeria or ghana' });
    }

    const existingEmail = await UserModel.findOne({ email });
    if (existingEmail) {
      return res.status(409).json({ success: false, message: 'Email already registered' });
    }

    let parsedMinerId = null;
    if (minerId) {
      const isNum = /^\d+$/.test(minerId);
      if (!isNum || minerId.length > 11) {
        return res.status(400).json({ success: false, message: 'Miner ID must be a number with a maximum of 11 digits' });
      }
      parsedMinerId = Number(minerId);

      const existingMinerId = await UserModel.findOne({ minerId: parsedMinerId });
      if (existingMinerId) {
        return res.status(409).json({ success: false, message: 'Miner ID already taken' });
      }
    }

    const hashedPassword = await bcrypt.hash(password, saltRounds);

    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    const user = await UserModel.create({
      username,
      email,
      phone_number,
      minerId: parsedMinerId,
      country,
      role: 'users',
      password: hashedPassword,
      isVerified: false,
      verificationToken: otp,
      verificationTokenExpires: Date.now() + 15 * 60 * 1000
    });

    // Same gap fixed on the web signup path: without this, an account has no
    // referral code of its own until something lazily generates one on first
    // use. Non-fatal — account creation must not fail over it.
    try {
      await referralCodeService.ensurePrimaryCode(user._id);
    } catch (codeErr) {
      console.error('SIGNUP REFERRAL CODE GEN ERROR:', codeErr.message || codeErr);
    }

    await emailService.sendOTP(email, otp);

    res.status(201).json({
      success: true,
      message: 'Account created successfully. Please verify the OTP sent to your email.',
      email,
      isVerified: false
    });

  } catch (error) {
    console.log('API REGISTER ERROR:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.resetPassword = async (req, res) => {
  try {
    let { email, currentPassword, newPassword, confirmPassword } = req.body;

    email           = email?.trim().toLowerCase();
    currentPassword = currentPassword?.trim();
    newPassword     = newPassword?.trim();
    confirmPassword = confirmPassword?.trim();

    if (!email || !currentPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({ success: false, message: 'All fields are required' });
    }

    if (!validator.isEmail(email)) {
      return res.status(400).json({ success: false, message: 'Invalid email address' });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ success: false, message: 'New password must be at least 8 characters' });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({ success: false, message: 'New passwords do not match' });
    }

    const user = await UserModel.findOne({ email });
    if (!user) {
      return res.status(404).json({ success: false, message: 'No account found with that email' });
    }

    const isValid = await bcrypt.compare(currentPassword, user.password);
    if (!isValid) {
      return res.status(401).json({ success: false, message: 'Current password is incorrect' });
    }

    user.password = await bcrypt.hash(newPassword, saltRounds);
    await user.save();

    res.json({ success: true, message: 'Password updated successfully' });

  } catch (error) {
    console.log('API RESET PASSWORD ERROR:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.verifyOTP = async (req, res) => {
  try {
    let { email, otp } = req.body;
    email = email?.trim().toLowerCase();

    if (!email || !otp) {
      return res.status(400).json({ success: false, message: 'Email and OTP are required' });
    }

    const user = await UserModel.findOne({
      email,
      verificationToken: otp,
      verificationTokenExpires: { $gt: Date.now() }
    });

    if (!user) {
      return res.status(400).json({ success: false, message: 'Invalid or expired OTP code' });
    }

    user.isVerified = true;
    user.verificationToken = undefined;
    user.verificationTokenExpires = undefined;
    await user.save();

    res.json({ success: true, message: 'Email verified successfully' });

  } catch (error) {
    console.error('API VERIFY OTP ERROR:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.resendOTP = async (req, res) => {
  try {
    let { email } = req.body;
    email = email?.trim().toLowerCase();

    if (!email) {
      return res.status(400).json({ success: false, message: 'Email is required' });
    }

    const user = await UserModel.findOne({ email });
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    user.verificationToken = otp;
    user.verificationTokenExpires = Date.now() + 15 * 60 * 1000;
    await user.save();

    await emailService.sendOTP(email, otp);

    res.json({ success: true, message: 'OTP resent successfully' });

  } catch (error) {
    console.error('API RESEND OTP ERROR:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};
