const mongoose = require('mongoose');

const coursePurchaseSchema = new mongoose.Schema({
  email: { type: String, required: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'user' },
  courseId: { type: String, required: true },
  courseTitle: { type: String, default: '' },
  price: { type: Number, default: 0 },
  // CSkillsHub's own currency for the price above — 'NGN' or 'USD'. Paid
  // courses deduct from the matching wallet balance (NAIRA for NGN, USDT for
  // USD); default 'NGN' covers rows written before this field existed, all
  // of which were NAIRA-only purchases.
  currency: { type: String, default: 'NGN' },
  // The course's RP value, read straight from the course API's own `rp`
  // field at purchase time. Display-only — kept here so the enrolment record
  // can still show what the course is worth, but never credited to
  // User.rpBalance on Kabacu. The real credit happens on CSkillsHub's side
  // (course completion, etc.) and reaches Kabacu through its own call to
  // POST /api/public/course-rp/credit; crediting it here too would double it.
  rpEarned: { type: Number, default: 0 },
  isPremium: { type: Boolean, default: false },
  free: { type: Boolean, default: false },
  transactionRef: { type: String },
}, { timestamps: true });

coursePurchaseSchema.index({ email: 1, courseId: 1 }, { unique: true });

module.exports = mongoose.model('CoursePurchase', coursePurchaseSchema);
