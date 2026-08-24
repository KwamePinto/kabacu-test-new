const bcrypt = require("bcrypt");
const crypto = require("crypto");
const saltRounds = 10;
const UserAdminModel = require("../../models/UserAdminModel");
const Transaction = require("../../models/TransactionModel");
const TopUp = require("../../models/TopUpModal");
const User = require("../../models/UserModel");
const sendEmail = require("../../utils/emailService");
const adminLayouts = "layouts/adminLayout";
const { generateUserAdminToken } = require("../../config/authUtils");
const { authenticateAdminUser, invalidateAdminCache } = require("../../config/authMiddleware");

/* ── helpers ────────────────────────────────────────────── */
function generateAdminPassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let pw = "CTC";
  for (let i = 0; i < 7; i++)
    pw += chars.charAt(Math.floor(Math.random() * chars.length));
  return pw;
}

function adminCredentialsEmail({ username, email, password, role, loginUrl }) {
  const roleLabel = role
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
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
            <h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.3px;">Kabacu Admin Portal</h1>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="padding:32px 32px 24px;">
            <h2 style="margin:0 0 16px;font-size:18px;color:#111827;">Welcome aboard, ${username}!</h2>
            <p style="margin:0 0 12px;color:#374151;line-height:1.7;font-size:14px;">
              You have been added as an administrator on the <strong>Kabacu</strong> platform. Your account is now active.
              Below are your login credentials — please keep them safe and confidential.
            </p>
            <!-- Credentials box -->
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;margin:24px 0;">
              <tr>
                <td style="padding:14px 20px;border-bottom:1px solid #e5e7eb;">
                  <span style="color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:.05em;">Email</span><br>
                  <strong style="color:#111827;font-size:14px;">${email}</strong>
                </td>
              </tr>
              <tr>
                <td style="padding:14px 20px;border-bottom:1px solid #e5e7eb;">
                  <span style="color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:.05em;">Temporary Password</span><br>
                  <strong style="color:#111827;font-size:15px;font-family:monospace;letter-spacing:.1em;">${password}</strong>
                </td>
              </tr>
              <tr>
                <td style="padding:14px 20px;">
                  <span style="color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:.05em;">Role</span><br>
                  <strong style="color:#111827;font-size:14px;">${roleLabel}</strong>
                </td>
              </tr>
            </table>
            <!-- CTA button -->
            <table width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0;">
              <tr>
                <td align="center">
                  <a href="${loginUrl}" style="display:inline-block;background:#47c363;color:#ffffff;font-size:14px;font-weight:700;padding:13px 32px;border-radius:6px;text-decoration:none;letter-spacing:.01em;">
                    Log In to Dashboard
                  </a>
                </td>
              </tr>
            </table>
            <!-- Security notice -->
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#fffbeb;border:1px solid #fcd34d;border-radius:6px;margin:0 0 20px;">
              <tr>
                <td style="padding:12px 16px;">
                  <p style="margin:0;color:#92400e;font-size:13px;line-height:1.6;">
                    <strong>Security notice:</strong> You will be prompted to complete your profile on first login. Please update your password immediately.
                  </p>
                </td>
              </tr>
            </table>
            <p style="margin:0;color:#9ca3af;font-size:12px;line-height:1.6;">
              If you did not expect this email, please contact your system administrator immediately at
              <a href="mailto:support@kabacu.com" style="color:#47c363;">support@kabacu.com</a>.
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

/* ── Login ──────────────────────────────────────────────── */
function renderLogin(res, error = null) {
  res.render("adminview/users/auth-login", { layout: adminLayouts, error });
}

exports.loginAdmin = (req, res) => {
  renderLogin(res);
};

exports.loginAdminPost = async (req, res) => {
  try {
    const { email, password, role } = req.body;

    const user = await UserAdminModel.findOne({ email });
    if (!user) return renderLogin(res, "Invalid email or password.");

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) return renderLogin(res, "Invalid email or password.");

    if (user.role !== role)
      return renderLogin(res, "Incorrect role selected for this account.");

    if (user.isActive === false)
      return renderLogin(
        res,
        "Your account has been deactivated. Contact a super admin.",
      );

    // ── 2FA gate ──────────────────────────────────────────────────────────
    // The password is correct, but that is not enough to authenticate. No
    // admin_token is issued here — only a PENDING marker in the session, which
    // grants access to nothing. The token is set in verifyOtpPost once the
    // emailed code checks out.
    req.session.pendingAdmin2fa = {
      id: String(user._id),
      email: user.email,
      at: Date.now(),
    };

    try {
      await issueAdminOtp(user);
    } catch (mailErr) {
      // If the code could not be delivered there is no way to complete login,
      // so fail closed rather than waving the admin through.
      console.error("[admin 2FA send]", mailErr);
      delete req.session.pendingAdmin2fa;
      return renderLogin(
        res,
        "We could not send your verification code. Please try again or contact a super admin.",
      );
    }

    return res.redirect("/command/verify");
  } catch (error) {
    console.log("Login error:", error);
    return renderLogin(res, "Something went wrong. Please try again.");
  }
};

/* ── Logout ─────────────────────────────────────────────── */
exports.logout = (req, res) => {
  res.clearCookie("admin_token");
  res.redirect("/command");
};

/* ── Admin management ───────────────────────────────────── */
exports.viewAdmins = [
  authenticateAdminUser,
  async (req, res) => {
    try {
      const [admins, pendingResets] = await Promise.all([
        UserAdminModel.find()
          .populate("addedBy", "username email")
          .sort({ createdAt: -1 })
          .lean(),
        UserAdminModel.find({ resetPasswordRequested: true })
          .select("username email role resetPasswordRequestedAt")
          .sort({ resetPasswordRequestedAt: -1 })
          .lean(),
      ]);
      res.render("adminview/users/view-admins", {
        admins,
        pendingResets,
        query: req.query,
        layout: adminLayouts,
      });
    } catch (error) {
      console.log("VIEW ADMINS ERROR:", error);
      res.redirect("/admin/main/dashboard");
    }
  },
];

exports.addAdminForm = [
  authenticateAdminUser,
  (req, res) => {
    res.render("adminview/users/add-admin", { layout: adminLayouts });
  },
];

exports.addAdminPost = [
  authenticateAdminUser,
  async (req, res) => {
    try {
      const { username, email, role } = req.body;

      const existing = await UserAdminModel.findOne({
        email: email.toLowerCase().trim(),
      });
      if (existing) {
        return res
          .status(400)
          .json({ error: "An admin with this email already exists." });
      }

      const plainPassword = generateAdminPassword();
      const hashedPassword = await bcrypt.hash(plainPassword, saltRounds);

      await UserAdminModel.create({
        username: username.trim(),
        email: email.toLowerCase().trim(),
        password: hashedPassword,
        role,
        profileCompleted: false,
        addedBy: req.user.id,
      });

      const loginUrl = `${req.protocol}://${req.get("host")}/command`;

      sendEmail({
        to: email.toLowerCase().trim(),
        subject: "Your Kabacu Admin Account Details",
        html: adminCredentialsEmail({
          username,
          email,
          password: plainPassword,
          role,
          loginUrl,
        }),
        text: `Welcome ${username}. Email: ${email} | Password: ${plainPassword} | Role: ${role}. Login at ${loginUrl}`,
      }).catch(emailErr => {
        console.error("ADD ADMIN — credentials email failed:", emailErr.message);
      });

      res.redirect("/admin/admins?success=1");
    } catch (error) {
      console.log("ADD ADMIN ERROR:", error);
      res.status(500).json({ error: error.message });
    }
  },
];

/* ── Toggle admin active state ──────────────────────────── */
exports.toggleAdminStatus = [
  authenticateAdminUser,
  async (req, res) => {
    try {
      if (req.user.role !== "super_admin") {
        return res
          .status(403)
          .json({ error: "Only super admins can perform this action." });
      }

      const { adminId, password } = req.body;

      if (!adminId || !password) {
        return res
          .status(400)
          .json({ error: "Admin ID and password are required." });
      }

      // Verify the super admin's own password
      const self = await UserAdminModel.findById(req.user.id);
      if (!self)
        return res
          .status(401)
          .json({ error: "Session invalid. Please log in again." });

      const passwordValid = await bcrypt.compare(password, self.password);
      if (!passwordValid)
        return res
          .status(401)
          .json({ error: "Incorrect password. Action cancelled." });

      const target = await UserAdminModel.findById(adminId);
      if (!target)
        return res.status(404).json({ error: "Admin account not found." });

      if (target._id.toString() === req.user.id) {
        return res
          .status(400)
          .json({ error: "You cannot deactivate your own account." });
      }

      target.isActive = !target.isActive;
      await target.save();
      invalidateAdminCache(target._id);

      res.json({
        success: true,
        isActive: target.isActive,
        message: `${target.username}'s account has been ${target.isActive ? "reactivated" : "deactivated"}.`,
      });
    } catch (error) {
      console.log("TOGGLE ADMIN STATUS ERROR:", error);
      res.status(500).json({ error: error.message });
    }
  },
];

/* ── Admin details ──────────────────────────────────────── */
exports.adminDetails = [
  authenticateAdminUser,
  async (req, res) => {
    try {
      const admin = await UserAdminModel.findById(req.params.id).populate(
        "addedBy",
        "username email",
      );
      if (!admin) return res.redirect("/admin/admins");

      res.render("adminview/users/admin-details", {
        admin,
        isSelf: admin._id.toString() === req.user.id,
        query: req.query,
        layout: adminLayouts,
      });
    } catch (error) {
      console.log("ADMIN DETAILS ERROR:", error);
      res.redirect("/admin/admins");
    }
  },
];

/* ── Update admin role (super_admin only) ───────────────── */
exports.updateAdminRole = [
  authenticateAdminUser,
  async (req, res) => {
    try {
      if (req.user.role !== "super_admin") {
        return res.status(403).json({
          error: "Only super admins can promote or demote administrators.",
        });
      }

      const { role, password } = req.body;
      const validRoles = ["super_admin", "senior_admin", "junior_admin"];

      if (!role || !validRoles.includes(role)) {
        return res.status(400).json({ error: "Invalid role selected." });
      }

      if (!password) {
        return res.status(400).json({ error: "Password is required." });
      }

      if (req.params.id === req.user.id) {
        return res
          .status(400)
          .json({ error: "You cannot change your own role." });
      }

      const self = await UserAdminModel.findById(req.user.id);
      if (!self)
        return res
          .status(401)
          .json({ error: "Session invalid. Please log in again." });

      const passwordValid = await bcrypt.compare(password, self.password);
      if (!passwordValid)
        return res
          .status(401)
          .json({ error: "Incorrect password. Action cancelled." });

      const target = await UserAdminModel.findById(req.params.id);
      if (!target)
        return res.status(404).json({ error: "Admin account not found." });

      const previousRole = target.role;
      target.role = role;
      await target.save();

      res.json({
        success: true,
        role: target.role,
        message:
          previousRole === role
            ? `${target.username}'s role is unchanged (${role.replace(/_/g, " ")}).`
            : `${target.username}'s role has been updated to ${role.replace(/_/g, " ")}.`,
      });
    } catch (error) {
      console.log("UPDATE ADMIN ROLE ERROR:", error);
      res.status(500).json({ error: error.message });
    }
  },
];

/* ── Delete admin account (super_admin only) ────────────── */
exports.deleteAdmin = [
  authenticateAdminUser,
  async (req, res) => {
    try {
      if (req.user.role !== "super_admin") {
        return res.status(403).json({ error: "Only super admins can delete admin accounts." });
      }

      const { password } = req.body;
      if (!password) {
        return res.status(400).json({ error: "Password is required." });
      }

      if (req.params.id === req.user.id) {
        return res.status(400).json({ error: "You cannot delete your own account." });
      }

      const self = await UserAdminModel.findById(req.user.id);
      if (!self) return res.status(401).json({ error: "Session invalid. Please log in again." });

      const passwordValid = await bcrypt.compare(password, self.password);
      if (!passwordValid) return res.status(401).json({ error: "Incorrect password. Action cancelled." });

      const target = await UserAdminModel.findById(req.params.id);
      if (!target) return res.status(404).json({ error: "Admin account not found." });

      await UserAdminModel.findByIdAndDelete(req.params.id);

      res.json({ success: true, message: `${target.username}'s account has been permanently deleted.` });
    } catch (error) {
      console.log("DELETE ADMIN ERROR:", error);
      res.status(500).json({ error: error.message });
    }
  },
];

/* ── Profile ────────────────────────────────────────────── */
exports.adminProfile = [
  authenticateAdminUser,
  async (req, res) => {
    try {
      const admin = await UserAdminModel.findById(req.user.id);
      const firstLogin = req.query.firstLogin === "1";
      res.render("adminview/profile", {
        admin,
        firstLogin,
        query: req.query,
        layout: adminLayouts,
      });
    } catch (error) {
      console.log("PROFILE ERROR:", error);
      res.redirect("/admin/main/dashboard");
    }
  },
];

exports.adminProfilePost = [
  authenticateAdminUser,
  async (req, res) => {
    try {
      const { phone, bio, department } = req.body;
      await UserAdminModel.findByIdAndUpdate(req.user.id, {
        phone: phone || "",
        bio: bio || "",
        department: department || "",
        profileCompleted: true,
      });
      if (req.body.firstLogin === '1') {
        return res.redirect("/admin/main/dashboard");
      }
      res.redirect("/admin/profile?saved=1");
    } catch (error) {
      console.log("PROFILE SAVE ERROR:", error);
      res.redirect("/admin/profile?error=1");
    }
  },
];

/* ── Password reset email template ─────────────────────── */
function adminPasswordResetEmail({ username, resetUrl }) {
  return `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:32px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);">
        <tr>
          <td style="background:#47c363;padding:28px 32px;text-align:center;">
            <h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">Password Reset Approved</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 32px 24px;">
            <h2 style="margin:0 0 12px;font-size:18px;color:#111827;">Hi ${username},</h2>
            <p style="margin:0 0 20px;color:#374151;line-height:1.7;font-size:14px;">
              Your password reset request has been approved. Click the button below to set a new password.
              This link is valid for <strong>1 hour</strong>.
            </p>
            <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
              <tr>
                <td align="center">
                  <a href="${resetUrl}" style="display:inline-block;background:#47c363;color:#ffffff;font-size:14px;font-weight:700;padding:14px 36px;border-radius:6px;text-decoration:none;">
                    Reset My Password
                  </a>
                </td>
              </tr>
            </table>
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#fffbeb;border:1px solid #fcd34d;border-radius:6px;margin:0 0 20px;">
              <tr>
                <td style="padding:12px 16px;">
                  <p style="margin:0;color:#92400e;font-size:13px;line-height:1.6;">
                    <strong>Did not request this?</strong> Ignore this email. Your password will not change unless you follow the link above.
                  </p>
                </td>
              </tr>
            </table>
            <p style="margin:0;color:#9ca3af;font-size:12px;">If the button does not work, copy and paste this URL into your browser:<br>
              <span style="word-break:break-all;color:#47c363;">${resetUrl}</span>
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

/* ── Forgot password (request) ──────────────────────────── */
exports.forgotPasswordGet = (req, res) => {
  res.render("adminview/users/forgot-password", {
    layout: false,
    query: req.query,
  });
};

exports.forgotPasswordPost = async (req, res) => {
  try {
    const email = (req.body.email || "").toLowerCase().trim();
    const admin = await UserAdminModel.findOne({ email });

    if (admin) {
      admin.resetPasswordRequested = true;
      admin.resetPasswordRequestedAt = new Date();
      await admin.save();
    }

    // Always redirect with ?sent=1 — don't reveal whether email exists
    res.redirect("/admin/forgot-password?sent=1");
  } catch (error) {
    console.log("FORGOT PASSWORD ERROR:", error);
    res.redirect("/admin/forgot-password?error=1");
  }
};

/* ── Approve reset (super_admin only) ───────────────────── */
exports.approveReset = [
  authenticateAdminUser,
  async (req, res) => {
    try {
      if (req.user.role !== "super_admin") {
        return res
          .status(403)
          .json({ error: "Only super admins can approve reset requests." });
      }

      const admin = await UserAdminModel.findById(req.params.id);
      if (!admin) return res.status(404).json({ error: "Admin not found." });
      if (!admin.resetPasswordRequested)
        return res
          .status(400)
          .json({ error: "No pending reset request for this admin." });

      const rawToken = crypto.randomBytes(32).toString("hex");
      const hashedToken = crypto
        .createHash("sha256")
        .update(rawToken)
        .digest("hex");

      admin.resetPasswordToken = hashedToken;
      admin.resetPasswordExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
      admin.resetPasswordRequested = false;
      admin.resetPasswordRequestedAt = null;
      await admin.save();

      const resetUrl = `${req.protocol}://${req.get("host")}/admin/reset-password?token=${rawToken}`;

      await sendEmail({
        to: admin.email,
        subject: "Kabacu Admin — Your Password Reset Link",
        html: adminPasswordResetEmail({ username: admin.username, resetUrl }),
        text: `Hi ${admin.username}, your password reset link: ${resetUrl} (valid 1 hour).`,
      });

      res.json({
        success: true,
        message: `Reset link sent to ${admin.email}.`,
      });
    } catch (error) {
      console.log("APPROVE RESET ERROR:", error);
      res.status(500).json({ error: error.message });
    }
  },
];

/* ── Reset password (from link) ─────────────────────────── */
exports.resetPasswordGet = async (req, res) => {
  try {
    const { token } = req.query;
    if (!token)
      return res.render("adminview/users/reset-password", {
        layout: false,
        tokenValid: false,
        error: "Invalid or missing reset link.",
      });

    const hashedToken = crypto.createHash("sha256").update(token).digest("hex");
    const admin = await UserAdminModel.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpires: { $gt: new Date() },
    });

    if (!admin) {
      return res.render("adminview/users/reset-password", {
        layout: false,
        tokenValid: false,
        error:
          "This reset link is invalid or has expired. Please request a new one.",
      });
    }

    res.render("adminview/users/reset-password", {
      layout: false,
      tokenValid: true,
      token,
      error: null,
    });
  } catch (error) {
    console.log("RESET PASSWORD GET ERROR:", error);
    res.render("adminview/users/reset-password", {
      layout: false,
      tokenValid: false,
      error: "Something went wrong. Please try again.",
    });
  }
};

exports.resetPasswordPost = async (req, res) => {
  try {
    const { token, password, confirmPassword } = req.body;
    if (!token) return res.redirect("/admin/forgot-password");

    if (!password || password.length < 8) {
      return res.render("adminview/users/reset-password", {
        layout: false,
        tokenValid: true,
        token,
        error: "Password must be at least 8 characters.",
      });
    }
    if (password !== confirmPassword) {
      return res.render("adminview/users/reset-password", {
        layout: false,
        tokenValid: true,
        token,
        error: "Passwords do not match.",
      });
    }

    const hashedToken = crypto.createHash("sha256").update(token).digest("hex");
    const admin = await UserAdminModel.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpires: { $gt: new Date() },
    });

    if (!admin) {
      return res.render("adminview/users/reset-password", {
        layout: false,
        tokenValid: false,
        error:
          "This reset link is invalid or has expired. Please request a new one.",
      });
    }

    admin.password = await bcrypt.hash(password, saltRounds);
    admin.resetPasswordToken = null;
    admin.resetPasswordExpires = null;
    await admin.save();

    res.redirect("/command?passwordReset=1");
  } catch (error) {
    console.log("RESET PASSWORD POST ERROR:", error);
    res.render("adminview/users/reset-password", {
      layout: false,
      tokenValid: false,
      error: "Something went wrong. Please try again.",
    });
  }
};

/* ── Notifications (JSON) ───────────────────────────────── */
// 30-second in-memory cache — notifications don't need sub-second freshness
let _notifCache = null;
let _notifCacheAt = 0;
const NOTIF_TTL_MS = 30_000;

exports.getNotifications = [
  authenticateAdminUser,
  async (req, res) => {
    try {
      if (_notifCache && Date.now() - _notifCacheAt < NOTIF_TTL_MS) {
        return res.json(_notifCache);
      }

      const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

      const [newUsers, pendingTopUps, recentFailedTx, recentPurchases, pendingRefunds] =
        await Promise.all([
          User.find({ createdAt: { $gte: since24h } })
            .select("username email createdAt")
            .sort({ createdAt: -1 })
            .limit(5)
            .lean(),
          TopUp.countDocuments({ status: "PENDING" }),
          Transaction.find({ status: "failed", createdAt: { $gte: since24h } })
            .select("amount reference createdAt")
            .sort({ createdAt: -1 })
            .limit(3)
            .lean(),
          Transaction.find({ status: "success", createdAt: { $gte: since24h } })
            .select("amount createdAt")
            .sort({ createdAt: -1 })
            .limit(5)
            .lean(),
          Transaction.countDocuments({
            "apiResponse.adminDeducted": true,
            "apiResponse.refundPending": true,
          }),
        ]);

      const notifications = [];

      newUsers.forEach((u) => {
        notifications.push({
          icon: "user-plus",
          color: "bg-success",
          text: `New user registered: <b>${u.username}</b>`,
          time: u.createdAt,
        });
      });

      if (pendingTopUps > 0) {
        notifications.push({
          icon: "clock",
          color: "bg-warning",
          text: `<b>${pendingTopUps}</b> wallet top-up${pendingTopUps > 1 ? "s" : ""} pending`,
          time: new Date(),
        });
      }

      recentFailedTx.forEach((tx) => {
        notifications.push({
          icon: "alert-triangle",
          color: "bg-danger",
          text: `Transaction failed — ₦${(tx.amount || 0).toLocaleString()} (ref: ${tx.reference || "—"})`,
          time: tx.createdAt,
        });
      });

      recentPurchases.forEach((tx) => {
        notifications.push({
          icon: "shopping-cart",
          color: "bg-primary",
          text: `New purchase — ₦${(tx.amount || 0).toLocaleString()}`,
          time: tx.createdAt,
        });
      });

      if (pendingRefunds > 0) {
        notifications.push({
          icon: "rotate-ccw",
          color: "bg-warning",
          text: `<b>${pendingRefunds}</b> refund request${pendingRefunds > 1 ? "s" : ""} pending approval`,
          time: new Date(),
          link: "/admin/flagged-transactions",
        });
      }

      // Sort by time descending, cap at 10
      notifications.sort((a, b) => new Date(b.time) - new Date(a.time));

      const payload = { success: true, notifications: notifications.slice(0, 10) };
      _notifCache   = payload;
      _notifCacheAt = Date.now();
      res.json(payload);
    } catch (error) {
      console.log("NOTIFICATIONS ERROR:", error);
      res.json({ success: false, notifications: [] });
    }
  },
];

/* ── Admin login 2FA ─────────────────────────────────────────────────────────
   A password alone never authenticates an admin. A correct password issues a
   one-time code by email and puts the request into a PENDING state held in the
   session; the admin_token cookie — the only thing authenticateAdminUser
   accepts — is not set until that code is verified. A pending session can
   therefore reach no admin route at all.                                    */

const OTP_TTL_MS       = 10 * 60 * 1000;  // code lifetime
const OTP_MAX_ATTEMPTS = 5;               // guesses before the code is burned
const OTP_RESEND_MS    = 60 * 1000;       // cooldown between sends

function generateOtp() {
  // crypto, not Math.random — this is an authentication factor.
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

function adminOtpEmail({ username, code, minutes }) {
  return `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:32px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);">
        <tr>
          <td style="background:#15a844;padding:24px 32px;text-align:center;">
            <h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:700;">Admin Login Verification</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 32px 24px;">
            <p style="margin:0 0 18px;color:#374151;font-size:14px;line-height:1.7;">
              Hi ${username || "there"}, use this code to finish signing in to the Kabacu admin dashboard.
            </p>
            <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">
              <tr><td align="center">
                <div style="display:inline-block;background:#f0fdf4;border:1px dashed #15a844;border-radius:8px;padding:16px 32px;">
                  <span style="font-family:'Courier New',monospace;font-size:32px;font-weight:700;letter-spacing:.28em;color:#111827;">${code}</span>
                </div>
              </td></tr>
            </table>
            <p style="margin:0 0 14px;color:#6b7280;font-size:13px;line-height:1.7;">
              It expires in <strong>${minutes} minutes</strong> and can only be used once.
            </p>
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#fef2f2;border:1px solid #fecaca;border-radius:6px;">
              <tr><td style="padding:12px 16px;">
                <p style="margin:0;color:#991b1b;font-size:13px;line-height:1.6;">
                  If you did not just try to sign in, someone may have your password.
                  Change it immediately and tell a super admin.
                </p>
              </td></tr>
            </table>
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

/** Issues a fresh code, stores only its hash, and emails it via Brevo. */
async function issueAdminOtp(admin) {
  const code = generateOtp();

  // Stored hashed, never in plain text: a dump of the admin collection would
  // otherwise hand over a live second factor.
  admin.twoFactorCodeHash   = await bcrypt.hash(code, saltRounds);
  admin.twoFactorExpires    = new Date(Date.now() + OTP_TTL_MS);
  admin.twoFactorAttempts   = 0;
  admin.twoFactorLastSentAt = new Date();
  await admin.save();

  const minutes = Math.round(OTP_TTL_MS / 60000);

  try {
    // Sent through the app's existing SES mailer — the same transport that
    // already delivers user verification OTPs, so there is no second provider
    // to keep configured or monitor.
    await sendEmail({
      to: admin.email,
      subject: `Your Kabacu admin code: ${code}`,
      html: adminOtpEmail({ username: admin.username, code, minutes }),
      text: `Your Kabacu admin verification code is ${code}. It expires in ${minutes} minutes.`,
    });
  } catch (err) {
    // Roll the record back if delivery failed. Otherwise an undelivered code
    // sits there for 10 minutes and twoFactorLastSentAt starts a resend
    // cooldown for a message that was never actually sent.
    admin.twoFactorCodeHash   = null;
    admin.twoFactorExpires    = null;
    admin.twoFactorAttempts   = 0;
    admin.twoFactorLastSentAt = null;
    await admin.save().catch(() => {});
    throw err;
  }
}

function renderOtp(res, opts = {}) {
  res.render("adminview/users/auth-verify-otp", {
    layout: adminLayouts,
    error:  opts.error  || null,
    notice: opts.notice || null,
    email:  opts.email  || "",
  });
}

/** victor@kabacu.com -> v*****r@kabacu.com */
function maskEmail(email) {
  const parts = String(email || "").split("@");
  const name = parts[0], domain = parts[1];
  if (!name || !domain) return "";
  if (name.length <= 2) return `${name[0]}*@${domain}`;
  return `${name[0]}${"*".repeat(Math.max(1, name.length - 2))}${name[name.length - 1]}@${domain}`;
}

/** Completes the login once the code checks out. */
function grantAdminSession(req, res, admin) {
  const token = generateUserAdminToken(admin);
  res.cookie("admin_token", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 24 * 60 * 60 * 1000,
  });

  req.session.info = { role: admin.role };
  delete req.session.pendingAdmin2fa;

  return admin.profileCompleted
    ? res.redirect("/admin/main/dashboard")
    : res.redirect("/admin/profile?firstLogin=1");
}

exports.verifyOtpPage = (req, res) => {
  const pending = req.session.pendingAdmin2fa;
  if (!pending) return res.redirect("/command");
  renderOtp(res, { email: maskEmail(pending.email) });
};

exports.verifyOtpPost = async (req, res) => {
  try {
    const pending = req.session.pendingAdmin2fa;
    if (!pending) return res.redirect("/command");

    const masked = maskEmail(pending.email);
    const code = String(req.body.code || "").replace(/\D/g, "");

    if (code.length !== 6) {
      return renderOtp(res, { email: masked, error: "Enter the 6-digit code from your email." });
    }

    const admin = await UserAdminModel.findById(pending.id);
    if (!admin) {
      delete req.session.pendingAdmin2fa;
      return renderLogin(res, "Something went wrong. Please sign in again.");
    }

    if (!admin.twoFactorCodeHash || !admin.twoFactorExpires) {
      return renderOtp(res, { email: masked, error: "No active code. Request a new one." });
    }

    if (admin.twoFactorExpires.getTime() < Date.now()) {
      return renderOtp(res, { email: masked, error: "That code has expired. Request a new one." });
    }

    // Count the attempt before comparing, so a crash mid-request cannot buy a
    // free retry.
    admin.twoFactorAttempts = (admin.twoFactorAttempts || 0) + 1;

    if (admin.twoFactorAttempts > OTP_MAX_ATTEMPTS) {
      // Burn the code rather than allow unlimited guesses at six digits.
      admin.twoFactorCodeHash = null;
      admin.twoFactorExpires  = null;
      await admin.save();
      delete req.session.pendingAdmin2fa;
      return renderLogin(res, "Too many incorrect codes. Please sign in again.");
    }

    const ok = await bcrypt.compare(code, admin.twoFactorCodeHash);
    if (!ok) {
      await admin.save();
      const left = OTP_MAX_ATTEMPTS - admin.twoFactorAttempts;
      const suffix = left > 0 ? ` ${left} attempt${left === 1 ? "" : "s"} left.` : "";
      return renderOtp(res, { email: masked, error: `Incorrect code.${suffix}` });
    }

    // Single use — cleared so the same code cannot be replayed.
    admin.twoFactorCodeHash = null;
    admin.twoFactorExpires  = null;
    admin.twoFactorAttempts = 0;
    await admin.save();

    return grantAdminSession(req, res, admin);
  } catch (err) {
    console.error("[admin 2FA verify]", err);
    return renderOtp(res, { error: "Something went wrong. Please try again." });
  }
};

exports.resendOtp = async (req, res) => {
  try {
    const pending = req.session.pendingAdmin2fa;
    if (!pending) return res.redirect("/command");

    const masked = maskEmail(pending.email);
    const admin = await UserAdminModel.findById(pending.id);
    if (!admin) {
      delete req.session.pendingAdmin2fa;
      return renderLogin(res, "Something went wrong. Please sign in again.");
    }

    const last = admin.twoFactorLastSentAt ? admin.twoFactorLastSentAt.getTime() : 0;
    const wait = OTP_RESEND_MS - (Date.now() - last);
    if (wait > 0) {
      return renderOtp(res, {
        email: masked,
        error: `Please wait ${Math.ceil(wait / 1000)}s before requesting another code.`,
      });
    }

    await issueAdminOtp(admin);
    return renderOtp(res, { email: masked, notice: "A new code is on its way." });
  } catch (err) {
    console.error("[admin 2FA resend]", err);
    return renderOtp(res, { error: "Could not send a new code. Please try again." });
  }
};
