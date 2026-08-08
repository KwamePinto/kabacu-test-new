require('dotenv').config();
const path = require('path');
const express = require('express');
const expressLayout = require('express-ejs-layouts');
const methodOverride = require('method-override');
const cookieParser = require('cookie-parser');
const MongoStore = require('connect-mongo').default;
const session = require('express-session');
const flash = require('connect-flash');
const morgan = require('morgan');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const csrf = require('csurf');

const connectDB = require('./server/config/db');
const loadUser = require('./server/config/loadUser');
const loadWallt = require('./server/config/loadWallet');
const loadBeneficiaries = require('./server/config/loadBeneficiaries');
const { optionalUser } = require('./server/config/authMiddleware');
const logger = require('./server/config/logger');

const app = express();
const PORT = process.env.PORT;

// Trust Render's (and any cloud host's) reverse proxy so req.ip returns
// the real client IP — without this, all users share one rate-limit bucket.
app.set('trust proxy', 1);

connectDB();

// ── Compression ───────────────────────────────────────────────────────────────
app.use(compression());

// ── Security headers ──────────────────────────────────────────────────────────
// CSP disabled: app uses CDN scripts + inline scripts/styles.
// Re-enable with proper nonces once those are migrated.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

// ── HTTP request logging (morgan → winston file) ──────────────────────────────
app.use(morgan('combined', {
  stream: { write: (msg) => logger.info(msg.trim()) },
}));

// ── Body parsing & cookies ────────────────────────────────────────────────────
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use(methodOverride('_method', { methods: ['POST', 'GET'] }));
app.use(express.static(path.join(__dirname, 'public')));

// ── CORS — applied to API routes only ─────────────────────────────────────────
// Web (browser-rendered) routes do not need CORS; keeping it only here prevents
// the wildcard header from weakening CSRF protection on the web side.
const apiCors = cors({
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
  credentials: true,
});

// ── Session ───────────────────────────────────────────────────────────────────
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,  // don't create a session until data is stored
  store: MongoStore.create({
    mongoUrl: process.env.MONGO_URI,
    collectionName: 'sessions',
    ttl: 14 * 24 * 60 * 60,
    touchAfter: 3 * 60 * 60, // only re-save session to DB if it changed, max once per 3h
  }),
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 14 * 24 * 60 * 60 * 1000,
  },
}));

app.use(flash());

// ── CSRF protection (web routes only, skip /api) ──────────────────────────────
const csrfProtection = csrf({ cookie: false }); // store secret in session

app.use((req, res, next) => {
  if (req.originalUrl.startsWith('/api')) return next();
  // PalmPay webhook is a server-to-server POST — no CSRF token possible
  if (req.originalUrl === '/palmpay/webhook') return next();
  // Mobile device registration uses x-token header auth — no CSRF token
  if (req.originalUrl === '/notification/register') return next();
  csrfProtection(req, res, next);
});

// ── Shared locals (flash, auth state, CSRF token) ─────────────────────────────
app.use((req, res, next) => {
  res.locals.csrfToken = req.csrfToken ? req.csrfToken() : '';
  res.locals.session = req.session;
  res.locals.isAuthenticated = !!req.user;
  res.locals.success_msg = req.flash('success');
  res.locals.error_msg = req.flash('error');
  next();
});

// ── User loaders ──────────────────────────────────────────────────────────────
app.use(optionalUser);
app.use(loadUser);
app.use(loadWallt);
app.use(loadBeneficiaries);

// ── View engine ───────────────────────────────────────────────────────────────
app.use(expressLayout);
app.set('layout', './layouts/main');
app.set('view engine', 'ejs');

// ── Maintenance mode (runs before all web routes) ─────────────────────────────
app.use(require('./server/middleware/maintenanceMiddleware'));

// ── Web routes ────────────────────────────────────────────────────────────────
app.use('/', require('./server/routes/webviewRoutes/packagesRoute'));
app.use('/user', require('./server/routes/webviewRoutes/userRoute'));
app.use('/category', require('./server/routes/webviewRoutes/categoryShopRoute'));
// ── Admin login shortcut ──────────────────────────────────────────────────────
const adminUserCtrl = require('./server/controllers/adminControllers/userAdminController');
app.get('/command', adminUserCtrl.loginAdmin);
app.post('/command', adminUserCtrl.loginAdminPost);

app.use('/admin', require('./server/routes/adminRoutes/userAdminRoute'));
app.use('/admin/main', require('./server/routes/adminRoutes/dashboardRoute'));
app.use('/admin/category', require('./server/routes/adminRoutes/categoryRoute'));
app.use('/admin/product', require('./server/routes/adminRoutes/productsRoute'));
app.use('/admin/settings', require('./server/routes/adminRoutes/settingsRoute'));
app.use('/admin/logs',          require('./server/routes/adminRoutes/logsRoute'));
app.use('/admin/networks',      require('./server/routes/adminRoutes/networksRoute'));
app.use('/admin/ourdatastore',    require('./server/routes/adminRoutes/ourdatastoreRoute'));
app.use('/admin/push-notifications', require('./server/routes/adminRoutes/notificationsRoute'));
app.use('/admin/profit',             require('./server/routes/adminRoutes/profitRoute'));
app.use('/admin/flagged-transactions', require('./server/routes/adminRoutes/damageControlRoute'));
app.use('/admin/notifications',       require('./server/routes/adminRoutes/adminNotificationsRoute'));
app.use('/admin/transactions',        require('./server/routes/adminRoutes/transactionsAdminRoute'));
app.use('/admin/faq',                 require('./server/routes/adminRoutes/faqRoute'));

// ── Notification device registration (mobile — x-token auth, no CSRF) ────────
app.post('/notification/register', require('./server/controllers/apiControllers/notificationController').registerDevice);

// ── API routes (CORS enabled here only) ──────────────────────────────────────
app.use('/api', apiCors, require('./server/routes/apiRoutes'));

// ── CSRF error handler ────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  if (err.code === 'EBADCSRFTOKEN') {
    if (req.originalUrl === '/command') {
      return res.redirect('/command');
    }
    if (req.originalUrl.startsWith('/admin')) {
      return res.redirect('/admin/main/dashboard');
    }
    req.flash('error', 'Your form session expired or was tampered with. Please try again.');
    const referer = req.get('Referer') || '/';
    return res.redirect(referer);
  }
  next(err);
});

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).render('errors/404', { layout: false });
});

// ── 500 handler ───────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  logger.error('Unhandled error: %s', err.stack || err.message);
  res.status(500).render('errors/404', { layout: false });
});

app.listen(PORT, () => {
  logger.info(`Server is running on port ${PORT}`);
  require('./server/services/transactionPoller').startPoller();
});