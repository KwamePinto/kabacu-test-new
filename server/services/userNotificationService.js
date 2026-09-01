const UserNotification = require('../models/UserNotificationModel');

const ICONS = {
  purchase:  'shopping-cart',
  success:   'check-circle',
  failed:    'x-circle',
  refund:    'rotate-ccw',
  attention: 'alert-triangle',
  info:      'bell',
  reward:    'gift',
};

async function notify(userId, { text, type = 'info', link } = {}) {
  if (!userId) return;
  try {
    await UserNotification.create({
      user: userId,
      text,
      type,
      icon: ICONS[type] || 'bell',
      link,
    });
  } catch (err) {
    console.error('[userNotify]', err.message);
  }
}

module.exports = { notify };
