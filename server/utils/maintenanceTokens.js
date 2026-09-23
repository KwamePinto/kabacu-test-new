/**
 * Turns a maintenance message containing {{date:VALUE}}, {{time:VALUE}}, and
 * {{countdown:VALUE}} tokens into safe HTML.
 *
 * Where the tokens come from: the admin editor (assets/js/maintenanceEditor.js,
 * loaded on views/adminview/settings.ejs) inserts them from the toolbar, or
 * inline by typing "{}" anywhere in the message. VALUE is always whatever a
 * native <input type="date">/"time"/"datetime-local"> produced — "YYYY-MM-DD",
 * "HH:MM", or "YYYY-MM-DDTHH:MM" — so it is re-validated here against that
 * exact charset before it ever reaches an HTML attribute. Belt and braces:
 * the editor is not expected to send anything else, but this function has no
 * way to know that a given call actually came from it.
 *
 * Formatting itself happens once per visitor, in their own browser, so a date
 * and a live countdown always read in that visitor's own clock. This
 * function's only job is to turn each token into an inert placeholder span;
 * assets/js/maintenanceEditor.js's fillTokenNodes() fills them in wherever
 * this HTML ends up — the admin editor's own live preview, the public
 * maintenance page, and the site-wide "upcoming maintenance" banner all call
 * the same function against their own rendered output. This regex and that
 * one are hand-kept in sync — one runs server-side, the other in the browser
 * — but the fill logic itself now lives in exactly one place.
 *
 * Same free-text-plus-tokens shape drives two independent surfaces:
 * SiteSettings.maintenanceMessage (the maintenance page itself, always on
 * while maintenanceModeEnabled is) and maintenanceBannerMessage (the
 * "upcoming maintenance" banner shown site-wide beforehand, while
 * maintenanceBannerEnabled is). See firstCountdownTarget() below for how the
 * banner decides when to stop showing itself.
 */

const TOKEN_RE = /\{\{(date|time|countdown):([0-9:T-]+)\}\}/g;
const VALUE_RE = /^[0-9:T-]+$/;

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderMaintenanceMessage(raw) {
  if (!raw) return '';
  let out = '';
  let last = 0;
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(raw))) {
    out += escapeHtml(raw.slice(last, m.index));
    const [, type, value] = m;
    if (VALUE_RE.test(value)) {
      out += '<span class="mt-token" data-mt="' + type + '" data-value="' + escapeHtml(value) + '"></span>';
    } else {
      // Should be unreachable given the regex already constrains the value —
      // kept as a fallback so a token that somehow fails validation stays
      // visible as literal text instead of silently vanishing from the notice.
      out += escapeHtml(m[0]);
    }
    last = TOKEN_RE.lastIndex;
  }
  out += escapeHtml(raw.slice(last));
  return out;
}

/**
 * The instant a {{countdown:...}} token in `raw` points at — the first one,
 * if there is more than one — or null if there isn't one, or it doesn't
 * parse to a valid date.
 *
 * Used by maintenanceMiddleware.js to decide when the "upcoming maintenance"
 * banner should stop showing itself: once this instant has passed, there is
 * nothing left to warn visitors is "upcoming". A banner message with no
 * countdown token at all has no such expiry — it shows for as long as
 * maintenanceBannerEnabled stays on, admin-controlled only.
 */
function firstCountdownTarget(raw) {
  if (!raw) return null;
  const re = /\{\{countdown:([0-9:T-]+)\}\}/;
  const m = re.exec(raw);
  if (!m) return null;
  const d = new Date(m[1]);
  return isNaN(d.getTime()) ? null : d;
}

module.exports = { renderMaintenanceMessage, firstCountdownTarget, TOKEN_RE, VALUE_RE };
