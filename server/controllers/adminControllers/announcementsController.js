const Announcement = require('../../models/AnnouncementModel');
const { authenticateAdminUser } = require('../../config/authMiddleware');
const { clearCache } = require('../../middleware/announcementsMiddleware');
const { PUBLIC_PAGES, isAllowedLink } = require('../../data/publicPages');

/**
 * The five hero slides that shipped hard-coded in the home page. They are
 * seeded once so the carousel keeps working exactly as before, and the admin
 * can then edit or delete them like any other banner.
 */
const SEED_BANNERS = [
  {
    type: 'banner', order: 1,
    eyebrow: 'Earn Rewards',
    title: 'Reward Points on Every Purchase',
    subtitle: 'Redeem RP for free data bundles',
    caption: 'Earn reward points on every purchase you make',
    image: '/assets/images/hero-slide-1.jpg',
    ctaLabel: 'Start Earning', ctaLink: '/category/data-category',
  },
  {
    type: 'banner', order: 2,
    eyebrow: 'All Networks',
    title: 'Top Up Any Network Instantly',
    subtitle: 'MTN · Airtel · Glo',
    caption: 'MTN · Airtel · Glo — always available, 24/7',
    image: '/assets/images/hero-slide-2.jpg',
    ctaLabel: 'Browse Plans', ctaLink: '/category/data-category',
  },
  {
    type: 'banner', order: 3,
    eyebrow: 'Instant Delivery',
    title: 'Data Delivered in Seconds',
    subtitle: 'Buy once, connect instantly',
    caption: 'Instant data delivery to any Nigerian number',
    image: '/assets/images/hero-slide-3.jpg',
    ctaLabel: 'Shop Now', ctaLink: '/category/data-category',
  },
  {
    type: 'banner', order: 4,
    eyebrow: 'Marketplace',
    title: 'Shop Phones, Gadgets & More',
    subtitle: 'Secure trades · Best deals · Easy exchange',
    caption: 'Phones, gadgets, fashion & more — all in one place',
    image: '/assets/images/hero-slide-4.jpg',
    ctaLabel: 'Explore Shop', ctaLink: '/',
  },
  {
    type: 'banner', order: 5,
    eyebrow: 'Best Plans',
    title: 'Buy Data Bundles in Seconds',
    subtitle: 'Fast, reliable plans at the best prices',
    caption: 'Fast, reliable data plans at the best prices',
    image: '/assets/images/hero-slide-5.jpg',
    ctaLabel: 'Shop Now', ctaLink: '/category/data-category',
  },
];

/** Demo strip + popup, created alongside the banner defaults. */
function seedSamples() {
  return [
    {
      type: 'strip', order: 1,
      title: 'Test strip',
      text: 'This is a test strip and it will be here for {countdown}',
      countdownEndsAt: new Date(Date.now() + 10 * 60 * 60 * 1000), // 10 hours
      background: '#e11d48',
      textColor: '#ffffff',
    },
    {
      type: 'popup', order: 1,
      eyebrow: 'Announcement',
      title: 'This is a test popup banner',
      subtitle: 'Popups appear once each time you sign in. An admin can change this image, heading and text from Announcements in the dashboard.',
      image: '/assets/images/new.PNG',
      ctaLabel: 'Browse Data Plans',
      ctaLink: '/category/data-category',
    },
  ];
}

/** Seeds defaults the first time the panel is opened. */
async function seedIfEmpty() {
  const count = await Announcement.countDocuments();
  if (count > 0) return;
  await Announcement.insertMany([...SEED_BANNERS, ...seedSamples()]);
  clearCache();
}

// Exported so it can also be run from a script/startup without the admin panel
exports.seedIfEmpty = seedIfEmpty;

/** Normalises checkbox/select values arriving as strings from the form. */
function toBool(v) {
  return v !== false && v !== 'false' && v !== undefined && v !== '' && v !== 'off';
}

/** Builds the writable fields from a request body + optional uploaded file. */
function fieldsFrom(req, existingImage) {
  const b = req.body;

  // multer puts a single upload on req.file; fall back to a pasted URL, then
  // to whatever the record already had, so editing without re-uploading is safe.
  let image = existingImage || '';
  if (req.file) image = '/uploads/' + req.file.filename;
  else if (b.imageUrl && b.imageUrl.trim()) image = b.imageUrl.trim();

  let countdownEndsAt = null;
  if (b.countdownEndsAt && String(b.countdownEndsAt).trim()) {
    const d = new Date(b.countdownEndsAt);
    if (!isNaN(d.getTime())) countdownEndsAt = d;
  } else if (b.countdownHours && Number(b.countdownHours) > 0) {
    countdownEndsAt = new Date(Date.now() + Number(b.countdownHours) * 3600 * 1000);
  }

  return {
    type:     b.type,
    title:    (b.title || '').trim(),
    eyebrow:  (b.eyebrow || '').trim(),
    subtitle: (b.subtitle || '').trim(),
    caption:  (b.caption || '').trim(),
    text:     (b.text || '').trim(),
    ctaLabel: (b.ctaLabel || '').trim(),
    ctaLink:  (b.ctaLink || '').trim(),
    background: (b.background || '#15a844').trim(),
    textColor:  (b.textColor || '#ffffff').trim(),
    image,
    countdownEndsAt,
    isActive: toBool(b.isActive),
    order:    Number(b.order) || 0,
  };
}

exports.viewPanel = [authenticateAdminUser, async (req, res) => {
  try {
    await seedIfEmpty();

    const all = await Announcement.find().sort({ type: 1, order: 1, createdAt: 1 }).lean();

    res.render('adminview/announcements', {
      layout: 'layouts/adminLayout',
      banners: all.filter(a => a.type === 'banner'),
      strips:  all.filter(a => a.type === 'strip'),
      popups:  all.filter(a => a.type === 'popup'),
      publicPages: PUBLIC_PAGES,
      csrfToken: res.locals.csrfToken,
    });
  } catch (err) {
    console.error('[announcements viewPanel]', err);
    res.render('adminview/announcements', {
      layout: 'layouts/adminLayout',
      banners: [], strips: [], popups: [],
      publicPages: PUBLIC_PAGES,
      csrfToken: res.locals.csrfToken,
    });
  }
}];

exports.create = [authenticateAdminUser, async (req, res) => {
  try {
    const data = fieldsFrom(req, '');

    if (!['banner', 'strip', 'popup'].includes(data.type)) {
      return res.json({ success: false, message: 'Pick a valid announcement type.' });
    }
    if (data.type === 'strip' && !data.text) {
      return res.json({ success: false, message: 'A strip needs its text.' });
    }
    if (data.type !== 'strip' && !data.title) {
      return res.json({ success: false, message: 'A title is required.' });
    }
    /* The dropdown only ever offers a page from the list, so a link outside it
       means the request did not come through that form — a hand-crafted POST,
       or a stale client. Either way it is refused rather than silently saved,
       which is what makes the dropdown a real restriction and not just a
       suggestion. */
    if (!isAllowedLink(data.ctaLink)) {
      return res.json({ success: false, message: 'Choose the button link from the list of pages.' });
    }

    if (!data.order) {
      data.order = (await Announcement.countDocuments({ type: data.type })) + 1;
    }

    const doc = await Announcement.create(data);
    clearCache();
    res.json({ success: true, message: 'Announcement created.', announcement: doc });
  } catch (err) {
    console.error('[announcements create]', err);
    res.json({ success: false, message: 'Server error. Please try again.' });
  }
}];

exports.update = [authenticateAdminUser, async (req, res) => {
  try {
    const existing = await Announcement.findById(req.params.id).lean();
    if (!existing) return res.json({ success: false, message: 'Announcement not found.' });

    const data = fieldsFrom(req, existing.image);
    data.type = existing.type; // type is fixed once created

    if (!isAllowedLink(data.ctaLink)) {
      return res.json({ success: false, message: 'Choose the button link from the list of pages.' });
    }

    const doc = await Announcement.findByIdAndUpdate(req.params.id, data, {
      new: true, runValidators: true,
    });

    clearCache();
    res.json({ success: true, message: 'Announcement updated.', announcement: doc });
  } catch (err) {
    console.error('[announcements update]', err);
    res.json({ success: false, message: 'Server error. Please try again.' });
  }
}];

exports.toggle = [authenticateAdminUser, async (req, res) => {
  try {
    const doc = await Announcement.findById(req.params.id);
    if (!doc) return res.json({ success: false, message: 'Announcement not found.' });

    doc.isActive = !doc.isActive;
    await doc.save();

    clearCache();
    res.json({ success: true, message: doc.isActive ? 'Activated.' : 'Deactivated.', isActive: doc.isActive });
  } catch (err) {
    console.error('[announcements toggle]', err);
    res.json({ success: false, message: 'Server error. Please try again.' });
  }
}];

exports.remove = [authenticateAdminUser, async (req, res) => {
  try {
    const doc = await Announcement.findByIdAndDelete(req.params.id);
    if (!doc) return res.json({ success: false, message: 'Announcement not found.' });

    clearCache();
    res.json({ success: true, message: 'Announcement deleted.' });
  } catch (err) {
    console.error('[announcements remove]', err);
    res.json({ success: false, message: 'Server error. Please try again.' });
  }
}];
