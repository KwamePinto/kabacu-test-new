const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'user', required: true },
  text: { type: String, required: true },
  type: { type: String, enum: ['purchase', 'success', 'failed', 'refund', 'attention', 'info', 'reward'], default: 'info' },
  icon: { type: String, default: 'bell' },
  link: { type: String },
  read: { type: Boolean, default: false },
}, { timestamps: true });

module.exports = mongoose.model('UserNotification', schema);
