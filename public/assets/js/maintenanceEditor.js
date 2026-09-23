/**
 * Rich token inserter for the maintenance-message textarea (admin settings).
 *
 * Lets an admin drop a {{date:...}}, {{time:...}}, or {{countdown:...}} token
 * into the message from a toolbar, or inline by typing "{}" anywhere in the
 * text. Either path opens a native <input type="date"/"time"/"datetime-local">
 * so picking a value is the browser's own date/time picker, not a hand-rolled
 * calendar widget.
 *
 * Kept in sync by hand with server/utils/maintenanceTokens.js (same token
 * regex, same escaping) and the inline script in views/webview/maintenance.ejs
 * (same date/time/countdown formatting). There's nowhere shared to import
 * from — this file is loaded as a plain <script>, the other two run
 * server-side and as a separate inline block. If the token shape ever
 * changes, all three need the same edit.
 *
 * Loaded identically on both KabakuNew's and KabakuOld's settings page; the
 * surrounding HTML differs per page's own design system, but the IDs passed
 * into init() are what ties this file to that page's markup.
 */
(function (global) {
  'use strict';

  var TOKEN_RE = /\{\{(date|time|countdown):([0-9:T-]+)\}\}/g;

  var TOKEN_KINDS = {
    date:      { label: 'Date',      icon: '📅', inputType: 'date' },
    time:      { label: 'Time',      icon: '🕒', inputType: 'time' },
    countdown: { label: 'Countdown', icon: '⏳',        inputType: 'datetime-local' },
  };
  var KIND_ORDER = ['date', 'time', 'countdown'];

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function todayLocalDate() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function nowLocalTime() {
    var d = new Date();
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function defaultValueFor(kind) {
    if (kind === 'date') return todayLocalDate();
    if (kind === 'time') return nowLocalTime();
    return todayLocalDate() + 'T' + nowLocalTime(); // countdown
  }

  /* Turns raw message text into HTML: literal text escaped, tokens replaced
     with inert placeholder spans a caller then fills in (see fillTokenNodes
     below). Mirrors server/utils/maintenanceTokens.js exactly. */
  function renderTokensToHtml(raw) {
    var out = '', last = 0, m;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(raw))) {
      out += escapeHtml(raw.slice(last, m.index));
      out += '<span class="mt-token" data-mt="' + m[1] + '" data-value="' + escapeHtml(m[2]) + '"></span>';
      last = TOKEN_RE.lastIndex;
    }
    out += escapeHtml(raw.slice(last));
    return out;
  }

  /* Fills every [data-mt] placeholder under `root` with readable text, and
     keeps any countdown spans ticking once a second. Mirrors the inline
     script in views/webview/maintenance.ejs exactly, so the admin's preview
     always matches what a visitor will actually see. */
  function fillTokenNodes(root) {
    var nodes = root.querySelectorAll('[data-mt]');
    for (var i = 0; i < nodes.length; i++) {
      (function (el) {
        var kind = el.getAttribute('data-mt');
        var value = el.getAttribute('data-value') || '';

        if (kind === 'date') {
          var d = new Date(value + 'T00:00:00');
          el.textContent = isNaN(d) ? value : d.toLocaleDateString('en-NG', {
            weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
          });
          return;
        }

        if (kind === 'time') {
          var t = new Date('2000-01-01T' + value + ':00');
          el.textContent = isNaN(t) ? value : t.toLocaleTimeString('en-NG', {
            hour: 'numeric', minute: '2-digit',
          });
          return;
        }

        if (kind === 'countdown') {
          var target = new Date(value);
          if (isNaN(target)) { el.textContent = value; return; }
          (function tick() {
            // Preview re-renders on every keystroke and replaces this node —
            // once it's no longer attached, let this timer chain stop rather
            // than tick forever against a detached element.
            if (!document.body.contains(el)) return;
            var diff = target - Date.now();
            if (diff <= 0) { el.textContent = 'any moment now'; return; }
            var dd = Math.floor(diff / 86400000);
            var hh = Math.floor((diff % 86400000) / 3600000);
            var mm = Math.floor((diff % 3600000) / 60000);
            var ss = Math.floor((diff % 60000) / 1000);
            el.textContent =
              (dd > 0 ? dd + 'd ' : '') +
              (dd > 0 || hh > 0 ? hh + 'h ' : '') +
              mm + 'm ' + ss + 's';
            setTimeout(tick, 1000);
          }());
        }
      }(nodes[i]));
    }
  }

  // ── Caret pixel position inside a <textarea> ───────────────────────────
  // Standard mirror-div technique: a hidden div styled to match the textarea
  // exactly, with the text up to the caret copied in and a marker span at
  // the end, whose offsetTop/offsetLeft is then the caret's position. There
  // is no direct DOM API for this — a <textarea> exposes selectionStart as
  // a character index, never a pixel.
  var MIRROR_PROPS = [
    'boxSizing', 'width', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize', 'fontSizeAdjust',
    'lineHeight', 'fontFamily', 'textAlign', 'textTransform', 'textIndent',
    'textDecoration', 'letterSpacing', 'wordSpacing', 'tabSize',
  ];

  function caretCoordinates(textarea, position) {
    var div = document.createElement('div');
    document.body.appendChild(div);
    var style = div.style;
    var computed = getComputedStyle(textarea);

    style.position = 'absolute';
    style.visibility = 'hidden';
    style.whiteSpace = 'pre-wrap';
    style.wordWrap = 'break-word';
    for (var i = 0; i < MIRROR_PROPS.length; i++) {
      style[MIRROR_PROPS[i]] = computed[MIRROR_PROPS[i]];
    }
    style.width = computed.width;

    div.textContent = textarea.value.substring(0, position);
    var span = document.createElement('span');
    span.textContent = textarea.value.substring(position) || '.';
    div.appendChild(span);

    var coords = {
      top:    span.offsetTop  + parseInt(computed.borderTopWidth  || '0', 10) - textarea.scrollTop,
      left:   span.offsetLeft + parseInt(computed.borderLeftWidth || '0', 10) - textarea.scrollLeft,
      height: parseInt(computed.lineHeight, 10) || 18,
    };
    document.body.removeChild(div);
    return coords;
  }

  function insertAt(textarea, start, end, text) {
    var value = textarea.value;
    textarea.value = value.slice(0, start) + text + value.slice(end);
    var caret = start + text.length;
    textarea.setSelectionRange(caret, caret);
    // Not textarea.focus()+dispatch alone: a real 'input' event is what
    // every other listener on this field (char counter, live preview,
    // this module's own caret tracking) already expects to react to.
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /**
   * @param {Object} opts
   * @param {string} opts.textareaId  id of the maintenance-message <textarea>
   * @param {string} opts.toolbarId   id of a container holding buttons with
   *                                  data-mt-insert="date|time|countdown"
   * @param {string} [opts.previewId] id of an element to render a live,
   *                                  formatted preview of the message into
   */
  function init(opts) {
    var textarea = document.getElementById(opts.textareaId);
    var toolbar  = document.getElementById(opts.toolbarId);
    var preview  = opts.previewId ? document.getElementById(opts.previewId) : null;
    if (!textarea || !toolbar) return null;

    var lastCaret = { start: textarea.value.length, end: textarea.value.length };
    function saveCaret() { lastCaret = { start: textarea.selectionStart, end: textarea.selectionEnd }; }
    textarea.addEventListener('keyup', saveCaret);
    textarea.addEventListener('click', saveCaret);
    textarea.addEventListener('select', saveCaret);

    function updatePreview() {
      if (!preview) return;
      preview.innerHTML = renderTokensToHtml(textarea.value);
      fillTokenNodes(preview);
    }

    // ── Value popover: one native picker for whichever kind was chosen ────
    var popover = document.createElement('div');
    popover.className = 'mt-popover';
    popover.hidden = true;
    popover.innerHTML =
      '<div class="mt-popover__row">' +
        '<input type="text" class="mt-popover__input">' +
        '<button type="button" class="mt-popover__btn mt-popover__btn--ok">Insert</button>' +
        '<button type="button" class="mt-popover__btn mt-popover__btn--cancel">Cancel</button>' +
      '</div>';
    document.body.appendChild(popover);
    var pInput  = popover.querySelector('.mt-popover__input');
    var pOk     = popover.querySelector('.mt-popover__btn--ok');
    var pCancel = popover.querySelector('.mt-popover__btn--cancel');

    var pending = null; // { kind, at, replaceLen }

    function closePopover() { popover.hidden = true; pending = null; }

    function openPopover(kind, x, y, at, replaceLen) {
      pInput.type  = TOKEN_KINDS[kind].inputType;
      pInput.value = defaultValueFor(kind);
      pending = { kind: kind, at: at, replaceLen: replaceLen || 0 };
      // Clamp on-screen so a picker opened near the right/bottom edge of the
      // textarea (a token typed late in a long message) doesn't render
      // partly off the viewport.
      var vw = document.documentElement.clientWidth;
      var maxX = vw + window.scrollX - 260;
      popover.style.left = Math.max(8, Math.min(x, maxX)) + 'px';
      popover.style.top  = y + 'px';
      popover.hidden = false;
      pInput.focus();
    }

    function commitPopover() {
      if (!pending || !pInput.value) return;
      var token = '{{' + pending.kind + ':' + pInput.value + '}}';
      insertAt(textarea, pending.at, pending.at + pending.replaceLen, token);
      closePopover();
      textarea.focus();
      saveCaret();
    }

    pOk.addEventListener('click', commitPopover);
    pInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter')  { e.preventDefault(); commitPopover(); }
      if (e.key === 'Escape') { e.preventDefault(); closePopover(); textarea.focus(); }
    });
    pCancel.addEventListener('click', function () { closePopover(); textarea.focus(); });

    // ── Toolbar buttons: insert at the last known caret position ──────────
    var toolbarBtns = toolbar.querySelectorAll('[data-mt-insert]');
    for (var i = 0; i < toolbarBtns.length; i++) {
      toolbarBtns[i].addEventListener('click', function (e) {
        var kind = e.currentTarget.getAttribute('data-mt-insert');
        var rect = textarea.getBoundingClientRect();
        openPopover(kind,
          rect.left + window.scrollX,
          rect.bottom + window.scrollY + 6,
          lastCaret.start, lastCaret.end - lastCaret.start);
      });
    }

    // ── Inline "{}" trigger ─────────────────────────────────────────────
    var inlineMenu = document.createElement('div');
    inlineMenu.className = 'mt-inline-menu';
    inlineMenu.hidden = true;
    inlineMenu.innerHTML = KIND_ORDER.map(function (kind) {
      var meta = TOKEN_KINDS[kind];
      return '<button type="button" class="mt-inline-menu__item" data-kind="' + kind + '">' +
        '<span class="mt-inline-menu__icon">' + meta.icon + '</span>' + meta.label + '</button>';
    }).join('');
    document.body.appendChild(inlineMenu);

    var triggerAt = null; // caret index where the consumed "{}" started

    function closeInlineMenu() { inlineMenu.hidden = true; triggerAt = null; }

    inlineMenu.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.mt-inline-menu__item') : null;
      if (!btn || triggerAt == null) return;
      var kind = btn.getAttribute('data-kind');
      var at = triggerAt;
      var coords = caretCoordinates(textarea, at);
      var rect = textarea.getBoundingClientRect();
      closeInlineMenu();
      openPopover(kind,
        rect.left + window.scrollX + coords.left,
        rect.top  + window.scrollY + coords.top + coords.height + 4,
        at, 0);
    });

    // One handler drives caret tracking, the "{}" shortcut, and the preview,
    // in that order — each depends on the caret/value state the previous
    // step left behind.
    textarea.addEventListener('input', function () {
      saveCaret();

      var pos = textarea.selectionStart;
      var value = textarea.value;
      if (pos >= 2 && value.slice(pos - 2, pos) === '{}') {
        // The two trigger characters are consumed, not left behind — the
        // admin is choosing a token, not typing literal braces.
        textarea.value = value.slice(0, pos - 2) + value.slice(pos);
        textarea.setSelectionRange(pos - 2, pos - 2);
        triggerAt = pos - 2;
        var coords = caretCoordinates(textarea, triggerAt);
        var rect = textarea.getBoundingClientRect();
        inlineMenu.style.left = (rect.left + window.scrollX + coords.left) + 'px';
        inlineMenu.style.top  = (rect.top  + window.scrollY + coords.top + coords.height + 4) + 'px';
        inlineMenu.hidden = false;
      }

      updatePreview();
    });

    textarea.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !inlineMenu.hidden) closeInlineMenu();
    });

    document.addEventListener('mousedown', function (e) {
      if (!inlineMenu.hidden && !inlineMenu.contains(e.target)) closeInlineMenu();
      if (!popover.hidden && !popover.contains(e.target) && !inlineMenu.contains(e.target)) closePopover();
    });

    updatePreview();

    return { updatePreview: updatePreview };
  }

  global.MaintenanceEditor = {
    init: init,
    renderTokensToHtml: renderTokensToHtml,
    fillTokenNodes: fillTokenNodes,
  };
}(window));
