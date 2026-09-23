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
 * and a live countdown always read in that visitor's own clock — the same
 * approach the scheduled-maintenance banner already uses (views/layouts/main.ejs).
 * This function's only job is to turn each token into an inert placeholder
 * span; a small inline script in views/webview/maintenance.ejs fills them in,
 * and assets/js/maintenanceEditor.js does the same for the live preview in
 * the admin editor. All three — this regex, that script, and this one — are
 * hand-kept in sync; there is nowhere shared to import them from, since one
 * runs server-side and the other two are plain <script> tags.
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

module.exports = { renderMaintenanceMessage, TOKEN_RE, VALUE_RE };
