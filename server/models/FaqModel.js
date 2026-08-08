const mongoose = require('mongoose');

const faqSchema = new mongoose.Schema({
  question: { type: String, required: true, trim: true },
  answer:   { type: String, required: true },
  category: {
    type: String,
    required: true,
    enum: ['getting-started', 'wallet', 'data', 'courses', 'account', 'rewards'],
  },
  order:    { type: Number, default: 0 },
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

faqSchema.index({ category: 1, order: 1 });

module.exports = mongoose.model('Faq', faqSchema);
