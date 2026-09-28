/**
 * Builds the "Chat with Support" handoff link for a parent app with a
 * Node.js/TypeScript backend — the TypeScript equivalent of the PHP snippet
 * in customer-support-client's USER_TODO.md.
 *
 * SERVER-SIDE ONLY. Never import this into browser/frontend code, and never
 * ship SSO_SHARED_KEY to a client bundle. This function's whole security
 * model rests on the shared key being known only to CTC's own backends —
 * anyone who can read it can forge a valid handoff link for ANY customer
 * email, with no further credential required. Call this from your own
 * server (an API route, a controller action, an SSR handler — anywhere that
 * already knows the logged-in user's own verified email server-side), and
 * only ever send the resulting URL to that user's own browser.
 *
 * Wire format (must match customer-support-client's SsoPayloadService.php
 * byte-for-byte — see that file's docblock):
 *   1. payload = JSON.stringify({ email, issued_at }) — issued_at is Unix
 *      seconds, an integer, not milliseconds.
 *   2. nonce = 24 random bytes (crypto_secretbox_NONCEBYTES).
 *   3. cipher = crypto_secretbox_easy(payload, nonce, key) — libsodium's
 *      XSalsa20-Poly1305 authenticated encryption, the same primitive PHP's
 *      sodium_crypto_secretbox() uses. This is NOT compatible with Node's
 *      built-in `crypto` module's AES functions — it must be actual
 *      libsodium, which is why this depends on `libsodium-wrappers` rather
 *      than Node's native crypto.
 *   4. encoded = base64url(nonce + cipher), no padding — Node's Buffer has
 *      this built in ('base64url'), so no hand-rolled encoder is needed.
 *
 * Requires: npm install libsodium-wrappers
 *           npm install -D @types/libsodium-wrappers   (TypeScript only)
 */

import sodium from 'libsodium-wrappers';

export interface CtcSupportSsoOptions {
  /** The customer support app's base URL. Defaults to production. */
  baseUrl?: string;
}

/**
 * @param email The logged-in user's OWN verified email — never one you
 *   haven't confirmed belongs to the current session, since a valid link is
 *   equivalent to that user's identity on the support side.
 * @param sharedKeyBase64 The SAME value as this app's SSO_SHARED_KEY env var
 *   (base64-encoded, 32 raw bytes) — read it from your own environment
 *   config at the call site, don't hardcode it.
 * @returns A full URL. Redirect the user's browser to it, or render it as a
 *   "Chat with Support" link/button.
 */
export async function ctcSupportSsoLink(
  email: string,
  sharedKeyBase64: string,
  options: CtcSupportSsoOptions = {}
): Promise<string> {
  await sodium.ready;

  const key = Buffer.from(sharedKeyBase64, 'base64');
  if (key.length !== sodium.crypto_secretbox_KEYBYTES) {
    // Fail loud here, not closed — this runs at link-build time in your own
    // backend, not per-request in customer-support-client, so there's no
    // "fail closed to a fallback flow" behavior to preserve. A misconfigured
    // key should break your build/integration test, not silently produce a
    // link that support will reject.
    throw new Error(
      `SSO_SHARED_KEY must decode to ${sodium.crypto_secretbox_KEYBYTES} bytes, got ${key.length}. ` +
        "Confirm you copied the exact base64 value from customer-support-client's .env — never generate a separate one."
    );
  }

  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const payload = JSON.stringify({ email, issued_at: Math.floor(Date.now() / 1000) });
  const cipher = sodium.crypto_secretbox_easy(Buffer.from(payload, 'utf8'), nonce, key);

  const encoded = Buffer.concat([Buffer.from(nonce), Buffer.from(cipher)]).toString('base64url');
  const baseUrl = options.baseUrl ?? 'https://customer.creativetimecenter.com';

  return `${baseUrl.replace(/\/+$/, '')}/open?e=${encoded}`;
}
