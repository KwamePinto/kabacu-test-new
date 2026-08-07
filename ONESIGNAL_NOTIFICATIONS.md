# OneSignal Push Notifications — How champsadmin Sends Them

This document explains how **champsadmin** currently sends push notifications to
leaders via OneSignal, and provides an equivalent reference implementation in
**Node.js / Express + EJS** for a developer who needs to add the same capability
to another app (e.g. an ecommerce admin panel).

See also: [DEVICE_REGISTRATION_ONESIGNAL.md in mobilechamps](../mobilechamps/DEVICE_REGISTRATION_ONESIGNAL.md)
for how the device tokens this system pushes to get registered in the first place.

---

## 1. Architecture Overview

```
 ┌─────────────────┐        writes player_id        ┌──────────────────────┐
 │   mobilechamps   │ ──────────────────────────────▶│   tbl_leader_devices  │
 │ (leader mobile   │   POST /api/device/register     │   (shared MySQL DB)  │
 │  app backend)    │                                 └──────────┬───────────┘
 └─────────────────┘                                             │ reads player_id(s)
                                                                  ▼
 ┌─────────────────┐   admin action / webhook event   ┌──────────────────────┐
 │    champsadmin   │ ─────────────────────────────────▶│ PushNotificationService│
 │ (admin backend,  │                                   │  → OneSignal REST API │
 │  holds API key)  │                                   └──────────────────────┘
 └─────────────────┘
```

- **champsadmin** decides *when* and *what* to send, and holds the OneSignal
  credentials (API key + App ID).
- **mobilechamps** registers each leader's OneSignal `player_id` into the
  shared `tbl_leader_devices` table whenever the mobile app calls its
  `/api/device/register` endpoint.
- The two apps never call each other's APIs directly — they communicate only
  through the shared database table.

---

## 2. Current Implementation (PHP)

### 2.1 Configuration

- `.env` / `.live.env` / `.test.env`: `ONESIGNAL_API_KEY=<REST API key>` and
  `ONESIGNAL_APP_ID=<App ID>` — both read from the environment.

```php
// app/Services/PushNotificationService.php
private string $appId;

public function __construct(Database $db)
{
    $this->db = $db;
    $this->appId = $_ENV['ONESIGNAL_APP_ID'];
}
```

### 2.2 Sending service

`app/Services/PushNotificationService.php` is the only class that talks to
OneSignal. It uses raw cURL against OneSignal's REST endpoint.

```php
public function sendToLeader(int $leaderId, string $title, string $message, int $badge): void
{
    $devices = $this->db->fetchAll(
        "SELECT player_id FROM tbl_leader_devices WHERE leader_id = ?",
        [$leaderId]
    );
    if (empty($devices)) return;

    $playerIds = array_column($devices, 'player_id');
    $this->send($playerIds, $title, $message, $badge);
}

private function send(array $playerIds, string $title, string $message, int $badge): void
{
    $data = [
        "app_id"              => $this->appId,
        "include_player_ids"  => $playerIds,
        "headings"            => ["en" => $title],
        "contents"            => ["en" => $message],
        "android_badgeType"   => "Increase",
        "android_badgeCount"  => $badge,
        "ios_badgeType"       => "Increase",
        "ios_badgeCount"      => $badge,
    ];

    $headers = [
        "Authorization: Basic " . $_ENV['ONESIGNAL_API_KEY'],
        "Content-Type: application/json"
    ];

    $ch = curl_init("https://api.onesignal.com/notifications");
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POSTFIELDS => json_encode($data)
    ]);
    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($httpCode !== 200) {
        error_log("OneSignal Error: " . $response);
    }
}
```

**Key facts:**

- Endpoint: `POST https://api.onesignal.com/notifications`
- Auth header: `Authorization: Basic <REST API key>`
- Targeting is done exclusively via **`include_player_ids`** — an array of
  OneSignal player IDs. The codebase never uses `included_segments`,
  `filters`, or `external_id` targeting.
- A "leader" maps to zero or more player IDs (one per device) via
  `tbl_leader_devices.leader_id`. All of a leader's devices get pushed to in
  a single OneSignal API call.

### 2.3 What triggers a send

| Trigger | File | Description |
|---|---|---|
| Admin sends a single notification | `NotificationController::notify()` → `NotificationService::sendNotification()` | `POST /api/notifications/notify` |
| Admin bulk-broadcasts | `NotificationController::bulkNotify()` → `NotificationService::sendBulkNotification()` | `POST /api/notifications/bulk-notify`, loops `sendToLeader()` per leader |
| External referral webhook | `ReferralController::sync()` | New referral → notifies the owning leader (hard-coded `message_id = 1`, "New Referral") |
| External level-up webhook | `ReferralController::levelUpdate()` → `ReferralService::processLevelUpdate()` → `AutoNotificationService::sendLevelUpAlert()` | Referral reaches level ≥ 5 → automated push, idempotent via a unique key on `tbl_automated_notifications` |

### 2.4 Data model

```sql
CREATE TABLE tbl_leader_devices (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  leader_id    INT UNSIGNED NOT NULL,
  player_id    VARCHAR(255) NOT NULL,   -- OneSignal player/subscription id
  device_id    VARCHAR(100) NOT NULL,   -- unique per physical device
  last_active  TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_at   TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_device (device_id),
  KEY idx_leader (leader_id)
);
```

- `tbl_notifications` — one row per notification sent to a leader (in-app
  record, independent of push delivery success).
- `tbl_messages` — reusable message templates (`title`, `message`, `type`).
- `tbl_automated_notifications` — idempotency/audit log for system-generated
  pushes; unique key on `(leader_id, event_type, ref_miner_id, level_id)`
  prevents double-sends when a webhook retries.

### 2.5 Reliability characteristics (current state)

- **No queue** — every send is synchronous, inline in the HTTP request that
  triggered it. A bulk broadcast fires one OneSignal call per leader,
  sequentially, in-request.
- **No retries** — a single cURL attempt; on non-200 it only `error_log`s the
  response body. The failure is swallowed (`void` return), so callers can't
  detect it.
- **Idempotency** (where it exists) is handled via a DB unique-key guard
  before the push is attempted, not via HTTP retry logic.

---

## 3. Reference Implementation — Node.js / Express + EJS

The following is a straight port of the above architecture for a Node.js +
Express backend that renders admin views with EJS. Adjust table/model names
to match the target app's schema (e.g. `orders`, `customers` instead of
`leaders`).

### 3.1 Environment

```bash
# .env
ONESIGNAL_APP_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
ONESIGNAL_API_KEY=os_v2_app_xxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### 3.2 Notification service

```js
// services/oneSignalService.js
const ONESIGNAL_URL = "https://api.onesignal.com/notifications";

async function sendToPlayerIds(playerIds, title, message, { badge = 0 } = {}) {
  if (!playerIds.length) return;

  const payload = {
    app_id: process.env.ONESIGNAL_APP_ID,
    include_player_ids: playerIds,
    headings: { en: title },
    contents: { en: message },
    android_badgeType: "Increase",
    android_badgeCount: badge,
    ios_badgeType: "Increase",
    ios_badgeCount: badge,
  };

  const res = await fetch(ONESIGNAL_URL, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${process.env.ONESIGNAL_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error("OneSignal error:", res.status, body);
    throw new Error(`OneSignal send failed (${res.status})`);
  }

  return res.json();
}

async function sendToCustomer(db, customerId, title, message, opts) {
  const devices = await db.query(
    "SELECT player_id FROM customer_devices WHERE customer_id = ?",
    [customerId]
  );
  const playerIds = devices.map((d) => d.player_id);
  return sendToPlayerIds(playerIds, title, message, opts);
}

module.exports = { sendToPlayerIds, sendToCustomer };
```

> Note the improvement over the PHP version: this throws on failure instead
> of silently swallowing the error, so the caller (or an Express error
> handler) can decide how to react — log, retry, or surface to the admin UI.

### 3.3 Express route (admin-triggered send)

```js
// routes/notifications.js
const express = require("express");
const router = express.Router();
const { sendToCustomer } = require("../services/oneSignalService");

router.post("/api/notifications/notify", async (req, res) => {
  const { customer_id, title, message } = req.body;
  try {
    await sendToCustomer(req.db, customer_id, title, message, { badge: 1 });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Failed to send notification" });
  }
});

router.post("/api/notifications/bulk-notify", async (req, res) => {
  const { customer_ids, title, message } = req.body;
  const results = await Promise.allSettled(
    customer_ids.map((id) => sendToCustomer(req.db, id, title, message))
  );
  const failed = results.filter((r) => r.status === "rejected").length;
  res.json({ ok: true, sent: customer_ids.length - failed, failed });
});

module.exports = router;
```

### 3.4 EJS view — admin "Send Notification" form

This is the view-layer piece that's specific to an EJS-based app: an admin
page with a form that posts to the route above.

```html
<!-- views/admin/notifications/send.ejs -->
<h1>Send Push Notification</h1>

<form method="POST" action="/api/notifications/notify" id="notify-form">
  <label>
    Customer
    <select name="customer_id" required>
      <% customers.forEach(function(c) { %>
        <option value="<%= c.id %>"><%= c.name %> (<%= c.email %>)</option>
      <% }); %>
    </select>
  </label>

  <label>
    Title
    <input type="text" name="title" maxlength="65" required>
  </label>

  <label>
    Message
    <textarea name="message" maxlength="240" required></textarea>
  </label>

  <button type="submit">Send</button>
</form>

<script>
  document.getElementById("notify-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const body = Object.fromEntries(new FormData(form));
    const res = await fetch(form.action, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    alert(data.ok ? "Notification sent" : `Failed: ${data.error}`);
  });
</script>
```

### 3.5 Bulk broadcast view (EJS)

```html
<!-- views/admin/notifications/bulk.ejs -->
<h1>Broadcast Notification</h1>

<form method="POST" action="/api/notifications/bulk-notify" id="bulk-form">
  <fieldset>
    <legend>Recipients</legend>
    <% customers.forEach(function(c) { %>
      <label>
        <input type="checkbox" name="customer_ids[]" value="<%= c.id %>">
        <%= c.name %>
      </label>
    <% }); %>
  </fieldset>

  <input type="text" name="title" placeholder="Title" required>
  <textarea name="message" placeholder="Message" required></textarea>
  <button type="submit">Broadcast</button>
</form>
```

### 3.6 Porting checklist

- [ ] Replace `customer_devices` / `customer_id` with the real schema names.
- [ ] Store `ONESIGNAL_APP_ID` and `ONESIGNAL_API_KEY` in env vars (don't
      hard-code the App ID like the original PHP does).
- [ ] Decide whether sends should be synchronous (fine for low volume, as in
      the original) or moved to a queue (BullMQ/Sidekiq-style) if broadcast
      volume is large enough that in-request loops would time out the HTTP
      request.
- [ ] Add a unique-key guard (like `tbl_automated_notifications`) for any
      event-driven/webhook-triggered sends so retries don't double-notify.
- [ ] Decide on retry policy for failed OneSignal calls — the original has
      none; a Node port could add exponential backoff since `fetch` errors
      are easy to catch.
