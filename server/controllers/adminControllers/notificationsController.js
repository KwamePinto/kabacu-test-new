const UserDevice          = require('../../models/UserDeviceModel');
const NotificationMessage = require('../../models/NotificationMessageModel');
const User                = require('../../models/UserModel');
const { sendToPlayers, sendToAll } = require('../../services/oneSignalService');
const { notify }          = require('../../services/userNotificationService');
const logger = require('../../config/logger');

async function viewPanel(req, res) {
  try {
    const [messages, devices, allUsers] = await Promise.all([
      NotificationMessage.find().sort({ createdAt: -1 }),
      UserDevice.find().populate('user', 'username email'),
      User.find({}, 'username email _id').sort({ username: 1 }).lean(),
    ]);

    // Group devices by user
    const userMap = {};
    for (const d of devices) {
      if (!d.user) continue;
      const uid = d.user._id.toString();
      if (!userMap[uid]) {
        userMap[uid] = { user: d.user, devices: [] };
      }
      userMap[uid].devices.push(d);
    }
    const registeredUsers = Object.values(userMap);

    res.render('adminview/notifications', {
      layout: 'layouts/adminLayout',
      title: 'Notifications',
      messages,
      registeredUsers,
      allUsers,
      tab: req.query.tab || 'messages',
    });
  } catch (err) {
    logger.error('notificationsController.viewPanel: %s', err.message);
    res.render('adminview/notifications', {
      layout: 'layouts/adminLayout',
      title: 'Notifications',
      messages: [],
      registeredUsers: [],
      allUsers: [],
      tab: 'messages',
      error: err.message,
    });
  }
}

async function addMessage(req, res) {
  try {
    const { title, body } = req.body;
    if (!title || !body) {
      req.flash('error', 'Title and body are required');
      return res.redirect('/admin/push-notifications?tab=messages');
    }
    await NotificationMessage.create({ title, body });
    req.flash('success', 'Message saved');
    return res.redirect('/admin/push-notifications?tab=messages');
  } catch (err) {
    logger.error('notificationsController.addMessage: %s', err.message);
    req.flash('error', 'Failed to save message');
    return res.redirect('/admin/push-notifications?tab=messages');
  }
}

async function deleteMessage(req, res) {
  try {
    await NotificationMessage.findByIdAndDelete(req.params.id);
    req.flash('success', 'Message deleted');
  } catch (err) {
    req.flash('error', 'Failed to delete message');
  }
  return res.redirect('/admin/push-notifications?tab=messages');
}

async function sendToUser(req, res) {
  try {
    const { userId, userIds, messageId, customTitle, customBody } = req.body;

    /* The picker posts one `userIds` field per selected user, which arrives as
       a string for one and an array for several. `userId` is the pre-picker
       single-select shape, kept so an older cached page still sends. */
    const targetIds = [].concat(userIds || [], userId || []).filter(Boolean);

    let title, body;
    if (messageId && messageId !== 'custom') {
      const msg = await NotificationMessage.findById(messageId);
      if (!msg) return res.json({ success: false, message: 'Message not found' });
      title = msg.title;
      body  = msg.body;
    } else {
      title = customTitle;
      body  = customBody;
    }

    if (!title || !body) return res.json({ success: false, message: 'Title and body are required' });
    if (!targetIds.length) return res.json({ success: false, message: 'No user selected' });

    // 1. In-app notification (bell icon on website)
    const inApp = { success: false, message: '', count: 0 };
    try {
      await Promise.all(targetIds.map(uid => notify(uid, { type: 'info', text: body, link: null })));
      inApp.success = true;
      inApp.count   = targetIds.length;
      inApp.message = 'In-app notification delivered to ' + targetIds.length +
        ' user' + (targetIds.length === 1 ? '' : 's') + '.';
    } catch (err) {
      logger.error('sendToUser in-app: %s', err.message);
      inApp.message = 'In-app notification failed: ' + err.message;
    }

    // 2. Push notification (mobile devices)
    const push = { success: false, message: '' };
    try {
      const devices = await UserDevice.find({ user: { $in: targetIds } });
      if (!devices.length) {
        push.message = 'No registered mobile devices for the selected user' +
          (targetIds.length === 1 ? '' : 's') + ' — push skipped.';
      } else {
        await sendToPlayers(devices.map(d => d.fcmToken), title, body);
        push.success = true;
        push.message = `Push sent to ${devices.length} device${devices.length > 1 ? 's' : ''}.`;
      }
    } catch (err) {
      logger.error('sendToUser push: %s', err.message);
      push.message = 'Push notification failed: ' + err.message;
    }

    return res.json({ success: true, inApp, push });
  } catch (err) {
    logger.error('notificationsController.sendToUser: %s', err.message);
    return res.json({ success: false, message: 'Server error: ' + err.message });
  }
}

async function broadcast(req, res) {
  try {
    const { messageId, customTitle, customBody, userIds } = req.body;

    let title, body;
    if (messageId && messageId !== 'custom') {
      const msg = await NotificationMessage.findById(messageId);
      if (!msg) return res.json({ success: false, message: 'Message not found' });
      title = msg.title;
      body  = msg.body;
    } else {
      title = customTitle;
      body  = customBody;
    }

    if (!title || !body) return res.json({ success: false, message: 'Title and body are required' });

    const targetIds = userIds
      ? (Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean)
      : [];

    // 1. In-app notifications (bell icon on website)
    const inApp = { success: false, message: '', count: 0 };
    try {
      let recipients;
      if (targetIds.length) {
        recipients = targetIds;
      } else {
        const allUsers = await User.find({}, '_id').lean();
        recipients = allUsers.map(u => u._id);
      }
      await Promise.all(recipients.map(uid => notify(uid, { type: 'info', text: body, link: null })));
      inApp.success = true;
      inApp.count   = recipients.length;
      inApp.message = `In-app notification sent to ${recipients.length} user${recipients.length !== 1 ? 's' : ''}.`;
    } catch (err) {
      logger.error('broadcast in-app: %s', err.message);
      inApp.message = 'In-app notifications failed: ' + err.message;
    }

    // 2. Push notification (mobile devices)
    const push = { success: false, message: '' };
    try {
      if (targetIds.length) {
        const devs = await UserDevice.find({ user: { $in: targetIds } });
        if (!devs.length) {
          push.message = 'No registered mobile devices for the selected users — push skipped.';
        } else {
          await sendToPlayers(devs.map(d => d.fcmToken), title, body);
          push.success = true;
          push.message = `Push sent to ${devs.length} device${devs.length !== 1 ? 's' : ''}.`;
        }
      } else {
        await sendToAll(title, body);
        push.success = true;
        push.message = 'Push notification broadcast to all registered mobile devices.';
      }
    } catch (err) {
      logger.error('broadcast push: %s', err.message);
      push.message = 'Push notification failed: ' + err.message;
    }

    return res.json({ success: true, inApp, push });
  } catch (err) {
    logger.error('notificationsController.broadcast: %s', err.message);
    return res.json({ success: false, message: 'Server error: ' + err.message });
  }
}

module.exports = { viewPanel, addMessage, deleteMessage, sendToUser, broadcast };
