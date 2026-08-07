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

    const token = generateUserAdminToken(user);
    res.cookie("admin_token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: 24 * 60 * 60 * 1000,
    });

    req.session.info = { role: user.role };

    if (!user.profileCompleted) {
      return res.redirect("/admin/profile?firstLogin=1");
    }

    res.redirect("/admin/main/dashboard");
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
