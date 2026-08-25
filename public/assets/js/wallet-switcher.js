/**
 * Wallet market switcher.
 *
 * Drives every `.wallet-switch` card on the page — the wallet page and the
 * profile page both have one, so this is written for many instances rather than
 * the single hard-coded card it started as.
 *
 * Each option already carries its own balance, so the card updates the moment
 * it is tapped rather than after the round trip. The page then reloads: which
 * products are purchasable, what currency every amount is shown in, and the
 * funding options are all decided server-side for the active market, and
 * patching them in place would leave the page disagreeing with the server.
 */
(function () {
  'use strict';

  function init(root) {
    var toggle = root.querySelector('.js-ws-toggle');
    var menu   = root.querySelector('.js-ws-menu');
    // The partial renders neither with only one market. Nothing to switch.
    if (!toggle || !menu) return;

    var symbolEl  = root.querySelector('.js-ws-symbol');
    var balanceEl = root.querySelector('.js-ws-balance');
    var nameEl    = root.querySelector('.js-ws-name');

    function close() {
      root.classList.remove('is-open');
      toggle.setAttribute('aria-expanded', 'false');
    }
    function open() {
      // Only one card's list open at a time.
      document.querySelectorAll('.wallet-switch.is-open').forEach(function (other) {
        if (other !== root) {
          other.classList.remove('is-open');
          var t = other.querySelector('.js-ws-toggle');
          if (t) t.setAttribute('aria-expanded', 'false');
        }
      });
      root.classList.add('is-open');
      toggle.setAttribute('aria-expanded', 'true');
    }

    toggle.addEventListener('click', function (e) {
      e.stopPropagation();
      // The card can sit inside a link or an accordion header.
      e.preventDefault();
      if (root.classList.contains('is-open')) close(); else open();
    });

    document.addEventListener('click', function (e) {
      if (!root.contains(e.target)) close();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') close();
    });

    menu.addEventListener('click', function (e) {
      var opt = e.target.closest('.js-ws-opt');
      if (!opt) return;
      e.preventDefault();
      e.stopPropagation();

      var code = opt.dataset.country;
      close();
      if (code === root.dataset.active) return;

      // Show the picked market's figures straight away — they are already here.
      if (symbolEl)  symbolEl.textContent  = opt.dataset.symbol;
      if (balanceEl) balanceEl.textContent = opt.dataset.balance;
      if (nameEl)    nameEl.textContent    = opt.dataset.currency;
      root.classList.add('is-busy');

      var csrf = (document.querySelector('meta[name="csrf-token"]') || {}).content
              || (window.KBC_CSRF || '');

      fetch('/my-wallet/switch-market', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ country: code }),
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (!data.success) {
            root.classList.remove('is-busy');
            if (window.Swal) {
              Swal.fire({ icon: 'error', text: data.message || 'Could not switch wallet.' });
            }
            return;
          }

          /* Keep the header's country picker in step. It reads this key for the
             flag and the currency symbol it paints across the page, so leaving
             it stale would show one market's flag over another's balance. */
          try {
            localStorage.setItem('kbc_country', data.country);
          } catch (_) {
            /* private window — the cookie the server just set still carries it */
          }

          window.location.reload();
        })
        .catch(function () {
          root.classList.remove('is-busy');
          if (window.Swal) {
            Swal.fire({ icon: 'error', text: 'Network error. Please try again.' });
          }
        });
    });
  }

  function boot() {
    document.querySelectorAll('.wallet-switch').forEach(init);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
