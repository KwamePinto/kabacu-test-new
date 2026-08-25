const countries = require('i18n-iso-countries');
countries.registerLocale(require('i18n-iso-countries/langs/en.json'));

/**
 * Country values arrive in three different shapes across this codebase:
 *
 *   user.country      lowercase display name  ("nigeria", "south africa")
 *   header picker     ISO alpha-2 code        ("NG")  — localStorage kbc_country
 *   product.country   ISO alpha-2 code        ("NG")  — the canonical form
 *
 * Everything is normalised to the ISO code before comparison so a user whose
 * profile says "nigeria" matches a package tagged "NG".
 */

const DEFAULT_COUNTRY = 'NG';

/** Anything → ISO alpha-2 uppercase, or null when unrecognised. */
function toCode(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  // Already a code
  if (/^[A-Za-z]{2}$/.test(raw)) {
    const up = raw.toUpperCase();
    return countries.isValid(up) ? up : null;
  }

  return countries.getAlpha2Code(raw, 'en')
      || countries.getAlpha2Code(raw.replace(/\b\w/g, c => c.toUpperCase()), 'en')
      || null;
}

/** ISO code → display name, falling back to the code itself. */
function toName(code) {
  if (!code) return '';
  return countries.getName(String(code).toUpperCase(), 'en') || String(code).toUpperCase();
}

/** Flag emoji for an ISO code. */
function toFlag(code) {
  const c = String(code || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return '';
  return c.replace(/./g, ch => String.fromCodePoint(127397 + ch.charCodeAt(0)));
}

/** Every country as { code, name }, alphabetical — for admin dropdowns. */
function allCountries() {
  const names = countries.getNames('en', { select: 'official' });
  return Object.keys(names)
    .map(code => ({ code, name: names[code] }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Which market this request should see, and which wallet is active.
 *
 *   code           the market whose products to show
 *   walletCountry  the market whose money is spendable (signed-in only)
 *   signedIn       whether there is a user behind this request
 *   locked         kept for the views; always false now that signed-in users
 *                  can switch market themselves
 *
 * Both signed-in and signed-out visitors may switch market — a signed-in user
 * browsing Ghana is a legitimate thing to want. What a signed-in user cannot do
 * is drag their money along: `walletCountry` only ever points at a country with
 * an active wallet, so switching to a market we do not hold money in leaves the
 * balance untouched. That is enforced when the switch is recorded, in
 * setWalletCountry() below.
 *
 * Signed-out visitors with no pick default to Nigeria, matching the flag the
 * header already shows them. Leaving it unfiltered would list several markets'
 * products side by side under a Nigerian flag, with prices in currencies the
 * visitor cannot pay in.
 *
 * Memoised on the request because several controllers and the middleware all
 * ask for it during one render.
 */
async function resolveViewerCountry(req) {
  if (req._viewerCountry) return req._viewerCountry;

  const picked = toCode(req.cookies && req.cookies.kbc_country);
  let result;

  if (req.user) {
    // Required lazily: this module is loaded by the model layer too, and a
    // top-level require here would create a cycle.
    const User = require('../models/UserModel');
    const doc = await User.findById(req.user.id).select('country walletCountry').lean();
    const profileCountry = toCode(doc && doc.country);

    result = {
      // A deliberate pick wins over the registration country.
      code: picked || profileCountry || DEFAULT_COUNTRY,
      walletCountry: toCode(doc && doc.walletCountry) || DEFAULT_COUNTRY,
      profileCountry,
      signedIn: true,
      locked: false,
    };
  } else {
    result = {
      code: picked || DEFAULT_COUNTRY,
      walletCountry: null,
      profileCountry: null,
      signedIn: false,
      locked: false,
    };
  }

  req._viewerCountry = result;
  return result;
}

/**
 * Record a market switch for a signed-in user and report what moved.
 *
 * The rule this enforces: money only follows the user into a market we actually
 * hold money in. Switching to a country with an active wallet moves the active
 * wallet; switching to one without leaves it exactly where it was, so a user
 * browsing Japan still spends from Naira.
 *
 * Returns { code, walletCountry, walletChanged }.
 */
async function setWalletCountry(userId, countryValue) {
  const code = toCode(countryValue);
  const User = require('../models/UserModel');
  const CountryWallet = require('../models/CountryWalletModel');

  const user = await User.findById(userId).select('walletCountry');
  if (!user) return null;

  const current = toCode(user.walletCountry) || DEFAULT_COUNTRY;
  if (!code) return { code: current, walletCountry: current, walletChanged: false };

  const wallet = await CountryWallet.findOne({ country: code, isActive: true }).lean();
  if (!wallet) {
    // No wallet for this market — browse it, but keep spending from the old one.
    return { code, walletCountry: current, walletChanged: false };
  }

  if (current !== code) {
    user.walletCountry = code;
    await user.save();
  }
  return { code, walletCountry: code, walletChanged: current !== code };
}

/**
 * The market a user should land on when they sign in.
 *
 * Their registration country if we have actually launched there — a wallet or
 * products is enough to count as launched — and Nigeria otherwise, so a user
 * who registered in a country we do not serve gets a working store rather than
 * an empty one. Switching away from it afterwards is their choice, and that is
 * when "coming soon" is the right thing to show.
 */
async function resolveLoginCountry(user) {
  const profile = toCode(user && user.country);
  if (!profile || profile === DEFAULT_COUNTRY) return DEFAULT_COUNTRY;

  const CountryWallet = require('../models/CountryWalletModel');
  const Product = require('../models/ProductsModal');

  const [wallet, productCount] = await Promise.all([
    CountryWallet.findOne({ country: profile, isActive: true }).select('_id').lean(),
    Product.countDocuments({ country: profile, is_deleted: { $ne: 1 } }),
  ]);

  return wallet || productCount > 0 ? profile : DEFAULT_COUNTRY;
}

/**
 * Mongo filter fragment for a resolved viewer country.
 * Signed-out visitors with no pick get {} — every market.
 */
function countryFilter(viewer) {
  if (!viewer || !viewer.code) return {};
  return { country: viewer.code };
}

/**
 * Currency per market.
 *
 * There is no currency package in the dependency tree, so the table lives here
 * as the server-side authority. `views/partials/header.ejs` carries a mirror of
 * it for client-side price formatting — keep the two in step when adding a row.
 *
 * Country wallets copy the currency onto their own record at creation time, so
 * a wallet created today keeps its symbol even if this table is edited later.
 */
const CURRENCIES = {
  NG: { code: 'NGN', symbol: '₦',  name: 'Naira'    },
  GH: { code: 'GHS', symbol: '₵',  name: 'Cedi'     },
  KE: { code: 'KES', symbol: 'KSh',      name: 'Shilling' },
  ZA: { code: 'ZAR', symbol: 'R',        name: 'Rand'     },
  TZ: { code: 'TZS', symbol: 'TSh',      name: 'Shilling' },
  UG: { code: 'UGX', symbol: 'USh',      name: 'Shilling' },
  RW: { code: 'RWF', symbol: 'FRw',      name: 'Franc'    },
  ZM: { code: 'ZMW', symbol: 'ZK',       name: 'Kwacha'   },
  EG: { code: 'EGP', symbol: 'E£', name: 'Pound'    },
  CM: { code: 'XAF', symbol: 'FCFA',     name: 'Franc'    },
  SN: { code: 'XOF', symbol: 'CFA',      name: 'Franc'    },
  CI: { code: 'XOF', symbol: 'CFA',      name: 'Franc'    },
  US: { code: 'USD', symbol: '$',        name: 'Dollar'   },
  GB: { code: 'GBP', symbol: '£',  name: 'Pound'    },
  CA: { code: 'CAD', symbol: '$',        name: 'Dollar'   },
  AU: { code: 'AUD', symbol: '$',        name: 'Dollar'   },
  IN: { code: 'INR', symbol: '₹',  name: 'Rupee'    },
  PK: { code: 'PKR', symbol: '₨',  name: 'Rupee'    },
  BD: { code: 'BDT', symbol: '৳',  name: 'Taka'     },
  CN: { code: 'CNY', symbol: '¥',  name: 'Yuan'     },
  JP: { code: 'JPY', symbol: '¥',  name: 'Yen'      },
  KR: { code: 'KRW', symbol: '₩',  name: 'Won'      },
  SG: { code: 'SGD', symbol: '$',        name: 'Dollar'   },
  MY: { code: 'MYR', symbol: 'RM',       name: 'Ringgit'  },
  PH: { code: 'PHP', symbol: '₱',  name: 'Peso'     },
  AE: { code: 'AED', symbol: 'AED',      name: 'Dirham'   },
  BR: { code: 'BRL', symbol: 'R$',       name: 'Real'     },
  MX: { code: 'MXN', symbol: '$',        name: 'Peso'     },
  RU: { code: 'RUB', symbol: '₽',  name: 'Ruble'    },
  SE: { code: 'SEK', symbol: 'kr',       name: 'Krona'    },
  CH: { code: 'CHF', symbol: 'CHF',      name: 'Franc'    },
  DE: { code: 'EUR', symbol: '€',  name: 'Euro'     },
  FR: { code: 'EUR', symbol: '€',  name: 'Euro'     },
  ES: { code: 'EUR', symbol: '€',  name: 'Euro'     },
  IT: { code: 'EUR', symbol: '€',  name: 'Euro'     },
  NL: { code: 'EUR', symbol: '€',  name: 'Euro'     },
};

/**
 * Currency for a market. Unknown countries fall back to their ISO code as the
 * symbol rather than a wrong one — an admin adding a market we have no entry
 * for sees "MW 500" and can correct the symbol on the wallet record itself.
 */
function currencyFor(value) {
  const code = toCode(value);
  if (code && CURRENCIES[code]) return { country: code, ...CURRENCIES[code] };
  return { country: code || '', code: '', symbol: code || '', name: '' };
}

module.exports = {
  DEFAULT_COUNTRY,
  CURRENCIES,
  currencyFor,
  toCode,
  toName,
  toFlag,
  allCountries,
  resolveViewerCountry,
  setWalletCountry,
  resolveLoginCountry,
  countryFilter,
};
