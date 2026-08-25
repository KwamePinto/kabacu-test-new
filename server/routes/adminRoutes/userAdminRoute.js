const express = require("express");
const router = express.Router();
const getAdminUsers = require("../../controllers/adminControllers/userAdminController");

// ── Auth ───────────────────────────────────────────────────
router.get("/login", getAdminUsers.loginAdmin);
router.post("/login", getAdminUsers.loginAdminPost);
router.get("/logout", getAdminUsers.logout);

// ── Password reset flow ────────────────────────────────────
router.get("/forgot-password", getAdminUsers.forgotPasswordGet);
router.post("/forgot-password", getAdminUsers.forgotPasswordPost);
router.get("/reset-password", getAdminUsers.resetPasswordGet);
router.post("/reset-password", getAdminUsers.resetPasswordPost);

// ── Approve reset (super_admin only) ──────────────────────
router.post("/admins/approve-reset/:id", getAdminUsers.approveReset);

// ── Profile ────────────────────────────────────────────────
router.get("/profile", getAdminUsers.adminProfile);
router.post("/profile", getAdminUsers.adminProfilePost);
router.post("/profile/two-factor", getAdminUsers.toggleOwnTwoFactor);

// ── Admin management (super_admin only) ───────────────────
router.get("/admins", getAdminUsers.viewAdmins);
router.get("/admins/add", getAdminUsers.addAdminForm);
router.post("/admins/add", getAdminUsers.addAdminPost);
router.post("/admins/toggle-status", getAdminUsers.toggleAdminStatus);
router.get("/admins/:id", getAdminUsers.adminDetails);
router.post("/admins/:id/role", getAdminUsers.updateAdminRole);
router.post("/admins/:id/two-factor", getAdminUsers.toggleAdminTwoFactor);
router.post("/admins/:id/delete", getAdminUsers.deleteAdmin);

// ── Notifications JSON ─────────────────────────────────────
router.get("/notifications", getAdminUsers.getNotifications);

module.exports = router;
