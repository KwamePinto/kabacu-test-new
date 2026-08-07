const mongoose = require('mongoose');

const UserDeviceSchema = new mongoose.Schema({
  user:     { type: mongoose.Schema.Types.ObjectId, ref: 'user', required: true },
  deviceId: { type: String, required: true, unique: true },
  fcmToken: { type: String, required: true },
  platform: { type: String, default: 'mobile' },
}, { timestamps: true });

module.exports = mongoose.model('UserDevice', UserDeviceSchema);
