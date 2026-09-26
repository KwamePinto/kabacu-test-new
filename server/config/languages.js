/**
 * Site languages, delivered by the Google Translate widget in layouts/main.ejs.
 *
 * The widget is hidden; what actually picks the language is Google's own
 * `googtrans` cookie ("/en/<code>"), which its script reads on load. Setting
 * that cookie on the server — at login and whenever the user changes the
 * setting — means every page opens already translated, with no extra
 * database read per request (req.user only carries what is in the JWT).
 *
 * Same set as the BitToken mining app (Herd/mine), kept in step on purpose.
 */

const LANGUAGES = [
    { code: 'en',    name: 'English' },
    { code: 'ar',    name: 'Arabic' },
    { code: 'zh-CN', name: 'Chinese' },
    { code: 'fr',    name: 'French' },
    { code: 'de',    name: 'German' },
    { code: 'hi',    name: 'Hindi' },
    { code: 'pt',    name: 'Portuguese (Brazil)' },
    { code: 'pt-PT', name: 'Portuguese (Portugal)' },
    { code: 'es',    name: 'Spanish' },
    { code: 'sw',    name: 'Swahili' },
    { code: 'ur',    name: 'Urdu' },
    { code: 'vi',    name: 'Vietnamese' },
];

const DEFAULT_LANGUAGE = 'en';
const LANGUAGE_CODES = LANGUAGES.map(l => l.code);

function isSupportedLanguage(code) {
    return LANGUAGE_CODES.includes(code);
}

/* Not httpOnly: Google's script has to read it. It holds nothing but a
   language code. English clears it rather than writing "/en/en", which would
   still make the widget run a no-op translation pass on every page. */
function setLanguageCookie(res, code) {
    if (!isSupportedLanguage(code) || code === DEFAULT_LANGUAGE) {
        res.clearCookie('googtrans', { path: '/' });
        return;
    }
    res.cookie('googtrans', `/${DEFAULT_LANGUAGE}/${code}`, {
        path: '/',
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 365 * 24 * 60 * 60 * 1000,
        // Raw "/en/fr", the form Google writes itself. Express would otherwise
        // URL-encode the slashes. Safe: the code is always from LANGUAGE_CODES.
        encode: String,
    });
}

module.exports = {
    LANGUAGES,
    LANGUAGE_CODES,
    DEFAULT_LANGUAGE,
    isSupportedLanguage,
    setLanguageCookie,
};
