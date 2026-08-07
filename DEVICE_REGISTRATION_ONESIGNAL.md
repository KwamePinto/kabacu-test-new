# Device Registration for Push Notifications — How mobilechamps Receives It

This document explains how **mobilechamps** (the leader-facing mobile app
backend) receives and stores a leader's OneSignal device token, so that
**champsadmin** can later push notifications to that device. It also
provides an equivalent reference implementation in **Node.js / Express +
EJS** for a developer porting this to another app (e.g. an ecommerce app
registering customer devices).

See also: [ONESIGNAL_NOTIFICATIONS.md in champsadmin](../champsadmin/ONESIGNAL_NOTIFICATIONS.md)
for how the tokens registered here are actually used to send pushes.

---

## 1. Architecture Overview

```
 Mobile app (leader device)
        │  OneSignal SDK generates/refreshes a player_id (subscription id)
        ▼
 POST /api/device/register   { miner_id, fcm_token, device_id }
        │  header: X-API-KEY: <shared secret>
        ▼
 DeviceController::register()  (mobilechamps)
        │  resolves miner_id → leader_id
        │  fcm_token  →  stored as player_id
        ▼
 tbl_leader_devices  (upsert keyed on device_id, shared MySQL DB)
        ▲
        │  read by leader_id at send time
 champsadmin PushNotificationService
```

`mobilechamps` and `champsadmin` never call each other directly — they
communicate only through the shared `tbl_leader_devices` table.

---

## 2. Current Implementation (PHP)

### 2.1 Route

```php
// routes/api.php
$router->post('/api/device/register', [DeviceController::class, 'register']);
```

### 2.2 Controller

```php
// app/Controllers/DeviceController.php
public function register(): void
{
    try {
        ApiAuth::validate();
        $data = $this->input();

        if (!$data['miner_id']) {
            $this->json([], "Unauthorized", 401);
            return;
        }

        $leader = $this->leaderService->getLeaderByMinerID($data['miner_id']);
        if (!$leader) {
            $this->json([], "Unauthorized", 401);
            return;
        }

        $data['player_id'] = $data['fcm_token'];

        if (empty($data['player_id']) || empty($data['device_id'])) {
            $this->json([], "Missing fields", 400);
            return;
        }

        $this->service->registerDevice($leader['id'], $data['player_id'], $data['device_id']);
        $this->json([], "Device registered successfully");
    } catch (\Throwable $th) {
        $this->errorService->submit('DeviceController', $th);
        $this->json([], "Error", 500);
    }
}
```

**Request payload:**

| Field | Purpose | Required |
|---|---|---|
| `miner_id` | identifies the leader account | yes — 401 if missing/unknown |
| `fcm_token` | remapped in code to `player_id` — this is actually the **OneSignal player ID**, despite the "fcm" name in the field | yes — 400 if empty |
| `device_id` | client device identifier | yes — 400 if empty |

There's no formal validator/DTO — validation is inline `empty()` checks.

### 2.3 Authentication

`ApiAuth::validate()` performs:

- CORS restricted to the app's own domain.
- OPTIONS preflight short-circuit (200).
- **Static API-key check**: header `X-API-KEY` must equal
  `$_ENV['EXTERNAL_API_KEY']`, else `401`.
- Rejects any non-POST method (405).

This is a shared static secret, not a per-user session/JWT. The actual
leader identity is resolved separately, inside the controller, by trusting
`miner_id` in the body and looking it up via
`LeaderService::getLeaderByMinerID()`.

### 2.4 Persistence (upsert)

```php
// app/Services/DeviceService.php
public function registerDevice($leaderId, $playerId, $deviceId)
{
    return $this->db->execute(
        "INSERT INTO tbl_leader_devices
              (leader_id, player_id, device_id)
              VALUES (?, ?, ?)
              ON DUPLICATE KEY UPDATE
              player_id = VALUES(player_id),
              leader_id = VALUES(leader_id)",
        [$leaderId, $playerId, $deviceId]
    );
}
```

```sql
CREATE TABLE tbl_leader_devices (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  leader_id    INT UNSIGNED NOT NULL,
  player_id    VARCHAR(255) NOT NULL,
  device_id    VARCHAR(100) NOT NULL,
  last_active  TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_at   TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_device (device_id),
  KEY idx_leader (leader_id)
);
```

**Key behaviors:**

- The upsert key is **`device_id`**, not `leader_id` — a leader can have
  multiple device rows (multiple devices), and re-registering the same
  device just overwrites its `player_id`/`leader_id`.
- `leader_id` is a foreign-key-by-convention to `tbl_leaders.id` (no DB-level
  `FOREIGN KEY` constraint).
- **No logout-time cleanup**: logging out does not clear or invalidate the
  device row — the stale `player_id` stays registered until a new
  registration call overwrites it.
- No device-type/OS field is stored — the schema is just
  `leader_id, player_id, device_id`.

### 2.5 Client trigger point

The mobilechamps repo itself contains no OneSignal SDK init or login-flow
code that calls this endpoint — it's a server API only. The actual client
call (typically fired from the OneSignal SDK's subscription-observer after
the SDK initializes and obtains a player ID, or on every app-open) lives in
the native/mobile client codebase, which isn't part of this repo.

---

## 3. Reference Implementation — Node.js / Express + EJS

### 3.1 Environment

```bash
# .env
EXTERNAL_API_KEY=replace-with-a-long-random-shared-secret
```

### 3.2 Auth middleware

```js
// middleware/apiAuth.js
function apiAuth(req, res, next) {
  if (req.method === "OPTIONS") return res.sendStatus(200);

  const key = req.header("X-API-KEY");
  if (key !== process.env.EXTERNAL_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

module.exports = apiAuth;
```

### 3.3 Route + controller

```js
// routes/device.js
const express = require("express");
const router = express.Router();
const apiAuth = require("../middleware/apiAuth");
const { getCustomerByExternalId } = require("../services/customerService");
const { registerDevice } = require("../services/deviceService");

router.post("/api/device/register", apiAuth, async (req, res) => {
  try {
    const { external_id, player_id, device_id } = req.body;

    if (!external_id) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const customer = await getCustomerByExternalId(req.db, external_id);
    if (!customer) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!player_id || !device_id) {
      return res.status(400).json({ error: "Missing fields" });
    }

    await registerDevice(req.db, customer.id, player_id, device_id);
    res.json({ ok: true, message: "Device registered successfully" });
  } catch (err) {
    console.error("DeviceController error:", err);
    res.status(500).json({ error: "Error" });
  }
});

module.exports = router;
```

> Improvement over the PHP version: name the field `player_id` directly in
> the API contract instead of accepting `fcm_token` and silently remapping
> it — avoids the confusing "fcm_token that's actually a OneSignal player
> id" naming from the original.

### 3.4 Upsert service

```js
// services/deviceService.js
async function registerDevice(db, customerId, playerId, deviceId) {
  await db.query(
    `INSERT INTO customer_devices (customer_id, player_id, device_id)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE
       player_id = VALUES(player_id),
       customer_id = VALUES(customer_id),
       last_active = CURRENT_TIMESTAMP`,
    [customerId, playerId, deviceId]
  );
}

module.exports = { registerDevice };
```

```sql
CREATE TABLE customer_devices (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  customer_id  INT UNSIGNED NOT NULL,
  player_id    VARCHAR(255) NOT NULL,
  device_id    VARCHAR(100) NOT NULL,
  last_active  TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_at   TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_device (device_id),
  KEY idx_customer (customer_id),
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);
```

### 3.5 Client-side registration (EJS-rendered page)

If the ecommerce app's customer-facing pages are server-rendered with EJS
(e.g. a PWA-style storefront rather than a native app), the OneSignal Web
SDK runs client-side and posts the player_id it obtains back to the route
above:

```html
<!-- views/layout/_onesignal.ejs -->
<!-- Included in the main layout so every page can register a device once
     the customer is logged in. -->
<% if (typeof currentCustomer !== 'undefined' && currentCustomer) { %>
<script src="https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.page.js" defer></script>
<script>
  window.OneSignalDeferred = window.OneSignalDeferred || [];
  OneSignalDeferred.push(async function (OneSignal) {
    await OneSignal.init({ appId: "<%= oneSignalAppId %>" });

    OneSignal.User.PushSubscription.addEventListener("change", async (event) => {
      const playerId = event.current.id;
      if (!playerId) return;

      await fetch("/api/device/register", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-KEY": "<%= publicDeviceRegisterKey %>",
        },
        body: JSON.stringify({
          external_id: "<%= currentCustomer.externalId %>",
          player_id: playerId,
          device_id: "<%= deviceId %>", // generated/stored client-side, e.g. in localStorage
        }),
      });
    });
  });
</script>
<% } %>
```

> Security note: don't actually expose a server-to-server `X-API-KEY`
> secret to the browser like this snippet does for illustration — for a
> browser-facing registration endpoint, authenticate the request with the
> customer's existing session/cookie instead, and drop the shared-secret
> header entirely. The static `X-API-KEY` scheme from the original PHP app
> only makes sense for **server-to-server** calls (e.g. a native mobile app
> backend calling this endpoint over HTTPS with a bundled secret), not for
> requests originating directly from a browser.

### 3.6 Porting checklist

- [ ] Rename `fcm_token` → `player_id` in the API contract (the original
      name is misleading).
- [ ] Add a real `FOREIGN KEY` from the device table to the owner table
      (the original PHP schema omits this).
- [ ] Decide whether logout should clear/deactivate the device row — the
      original does not, meaning stale tokens outlive the session until
      overwritten.
- [ ] If registration can happen from a browser (not just a native app),
      authenticate via session/cookie, not a shared static API key.
- [ ] Consider storing device/platform type (iOS/Android/Web) if the
      OneSignal payload will ever need per-platform fields — the original
      schema doesn't track this.
