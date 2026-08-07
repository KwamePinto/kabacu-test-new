const axios = require('axios');
const logger = require('../config/logger');

const BASE_URL = 'https://api.onesignal.com/notifications';

function headers() {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Basic ${process.env.ONESIGNAL_REST_API_KEY}`,
  };
}

async function sendToPlayers(playerIds, title, body, data = {}, { badge = 1 } = {}) {
  const payload = {
    app_id:             process.env.ONESIGNAL_APP_ID,
    include_player_ids: playerIds,
    headings:           { en: title },
    contents:           { en: body },
    android_badgeType:  'Increase',
    android_badgeCount: badge,
    ios_badgeType:      'Increase',
    ios_badgeCount:     badge,
    data,
  };
  try {
    const r = await axios.post(BASE_URL, payload, { headers: headers() });
    return r.data;
  } catch (err) {
    logger.error('OneSignal sendToPlayers error: %s', err.message);
    throw err;
  }
}

async function sendToAll(title, body, data = {}, { badge = 1 } = {}) {
  const payload = {
    app_id:             process.env.ONESIGNAL_APP_ID,
    included_segments:  ['All'],
    headings:           { en: title },
    contents:           { en: body },
    android_badgeType:  'Increase',
    android_badgeCount: badge,
    ios_badgeType:      'Increase',
    ios_badgeCount:     badge,
    data,
  };
  try {
    const r = await axios.post(BASE_URL, payload, { headers: headers() });
    return r.data;
  } catch (err) {
    logger.error('OneSignal sendToAll error: %s', err.message);
    throw err;
  }
}

module.exports = { sendToPlayers, sendToAll };
