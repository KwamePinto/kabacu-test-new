/**
 * Every page an announcement's button may point to.
 *
 * This is the single source of truth for "where can a banner/strip/popup send
 * someone" — the admin picks from this list rather than typing a path, and the
 * server checks a submitted link against it too. Free text here would let an
 * admin point a public-facing button at an admin route, an API endpoint, or a
 * typo'd path that 404s; a closed list cannot do either.
 *
 * Deliberately excludes: auth flows (login/signup steps, password reset,
 * OTP verification) — an announcement should not be steering a signed-in user
 * through a login form — and anything that needs a param to be useful
 * (checkout, a specific product). The home page and the signup page are the
 * two conventional "convert them now" destinations and are included for that.
 */
const PUBLIC_PAGES = [
  { path: '/',                          label: 'Home' },
  { path: '/categories',                label: 'All Categories' },
  { path: '/category/data-category',        label: 'Data Bundles' },
  { path: '/category/electronic-category',  label: 'Electronics' },
  { path: '/category/automobile-category',  label: 'Automobiles' },
  { path: '/category/course-category',      label: 'Courses' },
  { path: '/category/p2p-category',         label: 'P2P' },
  { path: '/my-wallet',                 label: 'My Wallet' },
  { path: '/history',                   label: 'Transaction History' },
  { path: '/my-topUps',                 label: 'Topups and History' },
  { path: '/conversion-history',        label: 'Conversion History' },
  { path: '/referrals',                 label: 'Referrals' },
  { path: '/user-profile',              label: 'My Profile' },
  { path: '/about',                     label: 'About Us' },
  { path: '/faq',                       label: 'FAQ' },
  { path: '/privacy-policy',            label: 'Privacy Policy' },
  { path: '/terms',                     label: 'Terms of Use' },
  { path: '/user/signup',               label: 'Sign Up' },
  { path: '/user/login',                label: 'Log In' },
];

/** True when a link is one of the approved destinations, or blank (no button). */
function isAllowedLink(link) {
  const value = String(link || '').trim();
  if (!value) return true;
  return PUBLIC_PAGES.some((p) => p.path === value);
}

module.exports = { PUBLIC_PAGES, isAllowedLink };
