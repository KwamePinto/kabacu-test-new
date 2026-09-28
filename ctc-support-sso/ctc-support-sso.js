/**
 * Builds the "Chat with Support" handoff link for a parent app with a
 * Node.js backend — plain-JS equivalent of ctc-support-sso.ts (same file,
 * no TypeScript). See that file for the full wire-format explanation.
 *
 * SERVER-SIDE ONLY. Never bundle this into browser/frontend code, and never
 * ship SSO_SHARED_KEY to a client. Anyone who can read the shared key can
 * forge a valid handoff link for ANY customer email — call this only from
 * your own server, where you've already verified the current user's own
 * email server-side, and only ever send the result to that same user.
 *
 * Requires: npm install libsodium-wrappers
 */

const sodium = require('libsodium-wrappers');

/**
 * @param {string} email The logged-in user's OWN verified email.
 * @param {string} sharedKeyBase64 The SAME value as customer-support-client's
 *   SSO_SHARED_KEY env var (base64-encoded, 32 raw bytes).
 * @param {{ baseUrl?: string }} [options]
 * @returns {Promise<string>} A full URL — redirect the user's browser to it.
 */
async function ctcSupportSsoLink(email, sharedKeyBase64, options = {}) {
  await sodium.ready;

  const key = Buffer.from(sharedKeyBase64, 'base64');
  if (key.length !== sodium.crypto_secretbox_KEYBYTES) {
    throw new Error(
      `SSO_SHARED_KEY must decode to ${sodium.crypto_secretbox_KEYBYTES} bytes, got ${key.length}. ` +
        "Confirm you copied the exact base64 value from customer-support-client's .env — never generate a separate one."
    );
  }

  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const payload = JSON.stringify({ email, issued_at: Math.floor(Date.now() / 1000) });
  const cipher = sodium.crypto_secretbox_easy(Buffer.from(payload, 'utf8'), nonce, key);

  const encoded = Buffer.concat([Buffer.from(nonce), Buffer.from(cipher)]).toString('base64url');
  const baseUrl = options.baseUrl || 'https://customer.creativetimecenter.com';

  return `${baseUrl.replace(/\/+$/, '')}/open?e=${encoded}`;
}

module.exports = { ctcSupportSsoLink };
