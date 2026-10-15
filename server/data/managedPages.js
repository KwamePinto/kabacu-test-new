/**
 * The pages an admin can toggle on/off for the public via the
 * Page Visibility admin section (server/controllers/adminControllers/pageFlagsController.js).
 *
 * Deliberately a short, curated list — the catalog/browse surface only.
 * Account pages (wallet, history, profile, referrals), legal pages, and auth
 * (login/signup) are left out on purpose: disabling those has nothing to do
 * with "this feature isn't ready yet", and for auth specifically it could
 * lock real users out entirely. Home is left out too — too core to ever want
 * a "coming soon" state.
 *
 * server/data/publicPages.js is a different list for a different job
 * (validating where an announcement's button may link to) and includes
 * exactly those account/legal/auth pages this list excludes — the two are
 * not meant to be the same list, though path values are kept consistent
 * between them.
 *
 * Adding a new toggle-able page is just adding one entry here and one
 * `pageGate(key)` call on its route(s) — no schema change needed, since
 * PageFlagModel documents are created lazily (see pageFlagsMiddleware.js).
 */
const MANAGED_PAGES = [
  { key: 'data',        label: 'Data Bundles', route: '/category/data-category' },
  { key: 'electronics', label: 'Electronics',  route: '/category/electronic-category' },
  { key: 'automobile',  label: 'Automobiles',  route: '/category/automobile-category' },
  { key: 'courses',     label: 'Courses',      route: '/category/course-category' },
  { key: 'p2p',         label: 'P2P',          route: '/category/p2p-category' },
];

const MANAGED_PAGES_BY_KEY = {};
MANAGED_PAGES.forEach((p) => { MANAGED_PAGES_BY_KEY[p.key] = p; });

module.exports = { MANAGED_PAGES, MANAGED_PAGES_BY_KEY };
