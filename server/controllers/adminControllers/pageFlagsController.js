const PageFlag = require('../../models/PageFlagModel');
const { authenticateAdminUser } = require('../../config/authMiddleware');
const { clearCache } = require('../../middleware/pageFlagsMiddleware');
const { MANAGED_PAGES_BY_KEY } = require('../../data/managedPages');

/** Normalises checkbox values arriving as strings from the form — mirrors announcementsController.js::toBool. */
function toBool(v) {
  return v !== false && v !== 'false' && v !== undefined && v !== '' && v !== 'off';
}

// Page Visibility is a section of Admin → Settings (see settingsController.js
// ::loadManagedPages for the listing), not its own page — this controller
// only has to handle the per-page save, posted via fetch from within the
// Settings view.
exports.save = [authenticateAdminUser, async (req, res) => {
  try {
    const { key } = req.params;
    if (!MANAGED_PAGES_BY_KEY[key]) {
      return res.json({ success: false, message: 'Unknown page.' });
    }

    const existing = await PageFlag.findOne({ key }).lean();
    const b = req.body;

    // An uploaded file wins, else a pasted URL, else keep whatever the
    // record already had — same precedence as announcementsController.js::fieldsFrom.
    let comingSoonImage = (existing && existing.comingSoonImage) || '';
    if (req.file) comingSoonImage = '/uploads/' + req.file.filename;
    else if (b.comingSoonImageUrl && b.comingSoonImageUrl.trim()) comingSoonImage = b.comingSoonImageUrl.trim();

    const update = {
      enabled: toBool(b.enabled),
      comingSoonTitle: (b.comingSoonTitle || '').trim(),
      comingSoonMessage: (b.comingSoonMessage || '').trim(),
      comingSoonImage,
    };

    const doc = await PageFlag.findOneAndUpdate(
      { key },
      { $set: update },
      { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true },
    );

    clearCache();
    res.json({ success: true, message: `${MANAGED_PAGES_BY_KEY[key].label} saved.`, flag: doc });
  } catch (err) {
    console.error('[pageFlags save]', err);
    res.json({ success: false, message: 'Server error. Please try again.' });
  }
}];
