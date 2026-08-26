/**
 * Kabacu admin panel — secondary drawer.
 *
 * Every `.kp-drawer__item` shows the `.kp-section` whose `data-section` matches
 * its `data-target`. All sections are already in the DOM, so switching is
 * instant; an admin comparing two settings should not wait for a page load.
 *
 * The choice is remembered per panel and mirrored into the URL hash, so a
 * reload — which is what a save does — comes back to the section they were on
 * rather than dumping them at the top.
 */
(function () {
  'use strict';

  function init(drawer) {
    var panel = drawer.dataset.panel || 'panel';
    var items = drawer.querySelectorAll('.kp-drawer__item');
    if (!items.length) return;

    var scope = drawer.closest('.kp-panel') || document;
    var storeKey = 'kbc_panel_' + panel;

    /* The visible label of a drawer item, minus its badge count — that text
       becomes the page's subtitle when the item is selected. */
    function labelOf(btn) {
      var span = btn.querySelector('span:not(.kp-drawer__badge)');
      return span ? span.textContent.trim() : btn.textContent.trim();
    }

    function show(target, remember) {
      var found = false;

      scope.querySelectorAll('.kp-section').forEach(function (sec) {
        var match = sec.dataset.section === target;
        sec.classList.toggle('is-active', match);
        if (match) found = true;
      });
      if (!found) return false;

      var activeBtn = null;
      items.forEach(function (btn) {
        var on = btn.dataset.target === target;
        btn.classList.toggle('is-active', on);
        btn.setAttribute('aria-current', on ? 'true' : 'false');
        if (on) activeBtn = btn;
      });

      /* The big page title stays the drawer's own name (e.g. "Referrals"); the
         line under it names whichever section is open, so the two together
         read "Referrals — Overview" without literally saying so. */
      if (activeBtn) {
        var label = labelOf(activeBtn);
        scope.querySelectorAll('.kp-panel__section-label').forEach(function (el) {
          el.textContent = label;
        });
      }

      if (remember) {
        try { localStorage.setItem(storeKey, target); } catch (e) { /* private mode */ }
        // replaceState so section switching does not fill the back button with
        // steps the admin never asked to navigate.
        if (window.history && window.history.replaceState) {
          window.history.replaceState(null, '', '#' + target);
        }
      }
      return true;
    }

    items.forEach(function (btn) {
      btn.addEventListener('click', function () {
        show(btn.dataset.target, true);
      });
    });

    /* Restore on load. The hash wins over the remembered value so a shared or
       bookmarked link always lands where it points. */
    var fromHash = (window.location.hash || '').replace('#', '');
    var stored = null;
    try { stored = localStorage.getItem(storeKey); } catch (e) { /* ignore */ }

    var wanted = fromHash || stored;
    // Falls back to the first item when the wanted section no longer exists —
    // a remembered id can outlive the section it named.
    if (!wanted || !show(wanted, false)) {
      show(items[0].dataset.target, false);
    }

    /* Any link pointing at a section switches to it, so a note in one section
       can send the admin to another: <a href="#requests">the queue</a> */
    document.addEventListener('click', function (e) {
      var a = e.target.closest('a[href^="#"]');
      if (!a) return;
      var id = a.getAttribute('href').slice(1);
      if (!id) return;
      if (show(id, true)) {
        e.preventDefault();
        var head = document.querySelector('.kp-panel__head');
        if (head && head.scrollIntoView) head.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  }

  function boot() {
    document.querySelectorAll('.kp-drawer__list').forEach(init);
    if (typeof feather !== 'undefined') feather.replace();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
