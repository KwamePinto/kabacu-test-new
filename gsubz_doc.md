# GSubz API — Integration Reference

Source: https://gsubz.com/api_doc/ (fetched 2026-08-31). This is a complete
working reference for onboarding GSubz as a data/airtime/TV/electricity
provider in Kabaku — every endpoint, every field, and every gap in their own
documentation that has to be closed **before** this touches real money.

**Read the "Documentation gaps & production risks" section before writing a
single line of integration code.** Several of these gaps are the exact shape
of bug that hit OurDataStore — a customer credited with data *and* refunded
their money — and this document exists specifically to stop that happening a
second time with a different provider.

---

## 1. Authentication

```
Authorization: Bearer ap_xxxxxxxxxxxxxxxxxxxx
```

- The key is issued on signup and can be reset from the GSubz dashboard.
- It is a **static key**, not a token you exchange or refresh. Contrast with
  OurDataStore, where `server/services/ourdatastore.js` exchanges a
  username/password for a Bearer token that expires and is cached for ~50
  minutes (`getToken()`). GSubz has no such lifecycle — the key is valid until
  someone resets it in the dashboard. That makes storage discipline (env var,
  never logged, never returned to the client) the *only* thing standing
  between a leak and unlimited abuse, since there is no expiry to limit the
  damage window.
- The docs also say "some GET requests don't require authentication" without
  saying which. **Do not assume — test each GET endpoint with the header
  omitted before relying on that.**

## 2. Base URL — inconsistent in GSubz's own examples

The docs use three different forms across their own example code:

| Example | URL used |
|---|---|
| `/category`, `/service`, `/fields`, `/plans`, `/variation` | `gsubz.com/api/{endpoint}` |
| `/pay` (the example labelled "flexible") | `gsubz.com/pay` — **no `/api/` segment** |
| `/pay` (the example labelled "fixed") | `gsubz.com/api/pay` |
| `/verify` | `https://gsubz.com/api/verify` — the only example with an explicit scheme |
| `/balance` | `gsubz.com/api/balance` |

**Treat `https://gsubz.com/api/` as the base URL for every endpoint** (matching
the majority of examples and the only endpoint that bothers to spell out
`https://`), and verify the bare `gsubz.com/pay` form is not a typo left in
their docs before trusting it. Sending a live payment request to a URL that
404s is a relatively safe failure; the risk is trusting it, having it
silently redirect or hit a stale endpoint, and not knowing whether the
resulting timeout means "nothing happened" or "it went through on the old
path." See §6 on why an ambiguous non-response has to be handled as "unknown,"
never as "failed."

There is also a dedicated `api.gsubz.com` subdomain — confirmed live,
`GET https://api.gsubz.com/api/plans?service={service}` returns the identical
response shape as `gsubz.com/api/plans?service={service}` with the same
Bearer key. Whether the two hosts are actually the same backend behind
different DNS names, or one is a CDN/proxy in front of the other, is not
documented — both worked in testing, so either is fine to use, but don't
assume every endpoint is mirrored on both hosts without checking.

## 3. Endpoints

### 3.1 `GET /category`

Lists the product categories GSubz supports.

**Request:** `GET https://gsubz.com/api/category`

**Response:**
```json
[
  { "displayName": "Electricity Billl", "name": "electricity" },
  { "displayName": "TV Subscriptions",  "name": "tv" },
  { "displayName": "Data Subscription", "name": "data" },
  { "displayName": "Airtime",           "name": "artime" },
  { "displayName": "Transfer",          "name": "transfer" }
]
```

> ⚠️ **Verbatim from their docs, not a transcription error**: `"Electricity
> Billl"` has three L's, and airtime's `name` is `"artime"` — misspelled in
> GSubz's own API, not just their marketing copy. If any integration code
> filters or matches on the category **name** (not `displayName`), it must
> match `"artime"` exactly, or every airtime lookup silently returns nothing.
> This is exactly the kind of thing that passes code review (looks like a
> typo, gets "corrected") and then breaks in production because the live API
> genuinely returns the misspelled value.

### 3.2 `GET /service?service={serviceID}`

Metadata for one service — name, logo, fee, product type, amount limits.

**Request:** `GET https://gsubz.com/api/service?service=mtn`

**Response:**
```json
{
  "service": "MTN Airtime",
  "field": [
    {
      "displayName": "system-load-setup",
      "name": "system-load-setup",
      "type": "text",
      "description": "",
      "regExp": "",
      "required": false
    }
  ]
}
```

> The example field (`system-load-setup`) does not look like a real
> user-facing input — it reads like leftover test/placeholder data in GSubz's
> own docs. Do not build a form field for it without confirming against a
> live call that it is real. This is a general theme with this
> documentation: treat every example as a *shape* to expect, not a literal
> contract for what a given `serviceID` will return — call it live and
> inspect the real response before wiring a UI to it.

### 3.3 `GET /fields?service={serviceID}`

The actual input fields a purchase for this service needs — this is what a
purchase form should be built from, not `/service`.

**Request:** `GET https://gsubz.com/api/fields?service=mtn`

**Response:**
```json
{
  "service": "mtn",
  "field": [
    { "displayName": "Amount",        "name": "amount", "type": "number", "description": "",                  "regExp": "[0-9]+", "required": true  },
    { "displayName": "Email",         "name": "email",  "type": "email",  "description": "",                  "regExp": "",        "required": false },
    { "displayName": "Phone",         "name": "phone",  "type": "text",   "description": "This is the description", "regExp": "[0-9]+", "required": true  },
    { "displayName": "Recharge Time", "name": "Date",   "type": "date",   "description": "",                  "regExp": "",        "required": false }
  ]
}
```

Field types observed: `text`, `number`, `email`, `date`. Each field carries
its own `regExp` for client-side validation and a `required` flag — **this is
meant to be read and driven dynamically per service**, not hardcoded once
from the `mtn` example. A TV service will need `customerID`; electricity will
need a meter number; the field list is how you're supposed to discover that
per-service rather than guess. Note the `"Date"` field's `name` is
capitalised (`Date`) while every other field is lowercase (`amount`, `email`,
`phone`) — another inconsistency to code defensively around (don't assume
`name` is always lowercase).

### 3.4 `GET /plans?service={serviceID}`

Available plans for a "fixed" service (data bundles, TV packages).

**Request:** `GET https://gsubz.com/api/plans?service=mtn_cg`

**Response:**
```json
{
  "service": "MTN-Coperate-Gifting-Data(*460*260#)",
  "PlanName": "plan",
  "fixedPrice": true,
  "plans": [
    { "displayName": "10GB - 30days",   "value": "257", "price": "2450" },
    { "displayName": "15GB - 30days",   "value": "259", "price": "3675" },
    { "displayName": "1GB - 30days",    "value": "213", "price": "245"  },
    { "displayName": "20GB - 30days",   "value": "258", "price": "4900" },
    { "displayName": "2GB - 30days",    "value": "215", "price": "490"  },
    { "displayName": "3GB - 30days",    "value": "216", "price": "735"  },
    { "displayName": "500MB - 30 Days", "value": "225", "price": "125"  },
    { "displayName": "5GB - 30days",    "value": "225", "price": "1225" }
  ]
}
```

- `value` is the plan identifier to send back as `plan` in `/pay`.
- `price` is a **string**, not a number (`"2450"`, not `2450`) — parse it
  before doing arithmetic (margin calculation, display formatting) or a
  string concatenation bug is waiting to happen.
- `fixedPrice: true` signals the service uses `/plans`+`plan` rather than a
  free-entry `amount`. Presumably a service can be `fixedPrice: false`
  (nothing in the docs shows that case) — build the branch for it rather than
  assuming every service you'll ever add is fixed-price.
- Plans are **not sorted** by size or price in the example (10GB, then 15GB,
  then 1GB, then 20GB…) — sort them yourself for display; don't trust API
  order to mean anything.
- Each plan also carries an **`api_price`** alongside `price` (not shown in
  GSubz's own doc example above, but present on every live response) — a
  second, lower figure. `price` reads as the suggested/display price; `api_price`
  is what `/pay` actually appears to charge when integrating programmatically.
  Confirmed the difference is real and consistent, e.g. MTN SME "1GB - 30days"
  showed `price: "399"` vs `api_price: "380.58"`. Use `api_price` for any cost
  comparison or margin calculation — `price` alone will overstate your cost.

> ⚠️ **`serviceID` values for data plans are not published anywhere in these
> docs**, and the docs' own example above (`mtn_cg`) is itself one of the
> ones that turned out not to work (see below) — copying it verbatim gets you
> `{"error":"Service not found or inactive"}`, indistinguishable from a typo.
> There is no `GET /services?category=data`-style endpoint to enumerate them;
> the only way to find them is the provider's own dashboard page source.
>
> Confirmed by testing live against this account (2026-08-31):
>
> | `serviceID` | Network | Plan type | Status |
> |---|---|---|---|
> | `mtn_sme` | MTN | SME | ✅ live (5 plans) |
> | `mtn_gifting` | MTN | Gifting | ✅ live (30 plans) |
> | `mtn_datashare` | MTN | Data Share | ✅ live (5 plans) |
> | `airtel_sme` | Airtel | SME | ✅ live (5 plans) |
> | `glo_data` | Glo | Data | ✅ live (13 plans) |
> | `glo_sme` | Glo | SME | ✅ live (4 plans) |
> | `mtn_cg` | MTN | Corporate Gifting | ❌ `Service not found or inactive` |
> | `mtn_cg_lite` | MTN | Corporate Gifting (SME 2.0) | ❌ `Service not found or inactive` |
> | `mtncg` | MTN | Corporate Gifting (alt id) | ❌ `Service not found or inactive` |
> | `mtn_coupon` | MTN | Data coupon | ❌ `Service not found or inactive` |
> | `airtel_cg` | Airtel | Corporate Gifting | ❌ `Service not found or inactive` |
> | `etisalat_data` | 9mobile | Data | ❌ `Service not found or inactive` |
>
> The four ❌ rows all return the identical error regardless of spelling
> (three different spellings of MTN corporate gifting were tried), which
> reads as **these services genuinely aren't enabled on this account** rather
> than a naming mistake — contact GSubz support to activate them if they're
> needed, rather than trying further spelling variations. Re-verify this
> table if GSubz ever confirms activation, since "inactive" today doesn't
> mean "inactive forever."

### 3.5 `GET /variation?service={serviceID}&value={planValue}`

Detail on one specific plan (used for TV packages in the example, but the
shape is identical to `/plans` filtered to one entry).

**Request:** `GET https://gsubz.com/api/variation?service=gotv&value=gotv-plus`

**Response:**
```json
{
  "service": "GoTV",
  "PlanName": "gotv-plan",
  "fixedPrice": true,
  "plans": [
    { "displayName": "gotv Plus", "value": "gotv-plus", "price": "100" }
  ]
}
```

Note the price shown (`"100"`) is obviously not a real GoTV Plus price —
another sign the example data in these docs is placeholder/test content, not
representative of live values. Never hardcode a price from documentation;
always resolve it live via `/plans` or `/variation` at purchase time.

### 3.6 `POST /pay` — the single purchase endpoint

**There is one endpoint for every purchase type.** GSubz distinguishes
"flexible" (airtime/transfer, free-entry `amount`) from "fixed" (data/TV,
fixed `plan` + `price`) by **which fields you send**, not by URL or an
explicit type parameter.

> ⚠️ **The two example payloads in GSubz's own docs are mislabelled** — this
> is the single most important thing in this document to get right before
> writing code.

The example under the heading **"Flexible/Airtime"** actually sends:
```php
$data = array(
    'serviceID'  => "gotv",
    'plan'       => "gotv-plus",
    'amount'     =>  1900,
    'customerID' => 111111,
    'phone'      => "0703xxxxxxxxxx",
    'email'      => "user@example.com",
    'requestID'  => time()+mt_rand()
);
```
— `serviceID: "gotv"`, a `plan`, and a `customerID`. **That is a TV/fixed
payment shape**, not airtime.

The example under the heading **"Fixed/Data or TV"** actually sends:
```php
$data = array(
    'serviceID' => "mtn",
    'phone'     => "0703xxxxxxxxxx",
    'email'     => "user@example.com",
    'amount'    =>  1000,
    'requestID' => time()+mt_rand()
);
```
— `serviceID: "mtn"`, a free `amount`, **no `plan`, no `customerID`**. **That
is an airtime/flexible payment shape.**

The examples are swapped relative to their own headings. If an integration is
built by literally copying "the fixed example" for a data/TV purchase, it
will submit an airtime-shaped request with no `plan` and no `customerID` —
which will most likely fail validation, but *could* just as easily be
accepted as a flexible top-up against the wrong service and take money for
the wrong product. **Ignore the headings. Build the payload from which fields
the product actually needs, using `/fields` per service as the source of
truth, not either worked example.**

**Correct payload shape by product type** (inferred from the actual field
lists in both examples, not their headings):

| Field | Flexible (airtime, transfer) | Fixed (data, TV) |
|---|---|---|
| `serviceID` | required — network/operator code (`mtn`, `airtel`, `glo`, `9mobile`, …) | required |
| `amount` | required, float, user-entered | required — **must match the plan's price** (unconfirmed whether GSubz validates this server-side or trusts the client; see §6) |
| `plan` | omit | required — the `value` from `/plans` or `/variation` |
| `customerID` | omit | required for TV (SmartCard/IUC number); presumably required for electricity (meter number) though no electricity example is shown |
| `phone` | required, **no country code** (`"0703xxxxxxxxxx"`, not `"+234..."` or `"234..."`) | required |
| `email` | optional | optional |
| `requestID` | required, unique per transaction | required |
| `api` | **not sent in the body** — auth is via the `Authorization: Bearer` header, in every worked `/pay` example | same |

**Response** (both payment types return the same envelope; PHP `print_r()`
dump from the docs, reformatted as JSON below — field names and misspellings
kept exactly as shown):

```json
{
  "code": 200,
  "status": "TRANSACTION_SUCCESSFUL",
  "description": "TRANSACTION_SUCCESSFUL",
  "content": {
    "transactionID": 189584034893843,
    "requestID": 897439437848,
    "amount": 2,
    "phone": "0703xxxxxxxxxxx",
    "serviceID": "mtn",
    "email": "user@example.com",
    "customerID": "",
    "plan": "",
    "image": "gsubz.com/uploads/XXXXXXXX.jpg",
    "convinience_fee": 0,
    "productType": "flexible",
    "serviceName": "MTN Airtime VTU",
    "status": "TRANSACTION_SUCCESSFUL",
    "code": "000",
    "description": "TRANSACTION_SUCCESSFUL",
    "date": "2019-03-22T11:16:05+01:00"
  },
  "gateway": {
    "referrer": "gsubz.com/xxxxxxxx.html",
    "host": "recharge.lajela.com",
    "ip": "185.2.168.39"
  }
}
```

> ⚠️ `"convinience_fee"` is spelled exactly like that in the API — not
> "convenience_fee". Reading `response.content.convenience_fee` will always
> return `undefined` and silently pass through as `NaN`/`0` in a fee
> calculation. This is the single easiest silent bug in this whole
> integration — grep for it before shipping if it's ever renamed on either
> side.

> Two different fields are both called `code`, at two different nesting
> levels, meaning two different things:
> - `content.code` (`"000"` string) is the **provider's own service-level
>   result code** — success/failure of the actual purchase.
> - the top-level `code` (`200` number) is closer to an **HTTP-style status**
>   for the API call itself.
> A response can plausibly have top-level `code: 200` (the API call itself
> succeeded) while `content.code` says something other than `"000"` (the
> purchase itself failed) — **the top-level code alone is not proof of a
> successful purchase.** Always check `content.code === "000"` (or
> `content.status === "TRANSACTION_SUCCESSFUL"`) before crediting/marking
> anything successful, never the outer envelope alone.

`gateway.host` (`recharge.lajela.com` in the example) suggests GSubz is
itself a reseller/aggregator sitting in front of another upstream provider —
worth being aware that a failure could originate one hop further back than
GSubz's own systems, which is relevant to how patient a retry/backoff policy
needs to be.

### 3.7 `POST /verify`

Poll a transaction's outcome by `requestID`. This is the **only** mechanism
GSubz documents for finding out what actually happened to a payment — see §6,
there is no webhook.

**Request:**
```php
$data = array('requestID' => 8755965695964845);
// header: Authorization: Bearer $api
```

**Response** (the only example GSubz provides is a *failed* transaction):
```json
{
  "code": 402,
  "status": "TRANSACTION_FAILED",
  "description": "INSUFFICIENT_BALANCE",
  "content": {
    "transactionID": 8585405894594,
    "requestID": 3414793352,
    "amount": 2,
    "phone": "090xxxxxxxxxxx",
    "serviceID": "gotv",
    "email": "user@example.com",
    "customerID": "7017725579",
    "plan": "gotv-plus",
    "image": "gsubz.com/images/products/200X200/Gotv-Payment.jpg",
    "convinience_fee": 100,
    "productType": "fix",
    "serviceName": "Gotv Payment",
    "status": "TRANSACTION_FAILED",
    "code": "016",
    "description": "INSUFFICIENT_BALANCE",
    "date": "2019-03-22T11:16:05+01:00"
  },
  "gateway": { "referrer": "gsubz.com/xxxxxxxx.html", "host": "recharge.lajela.com", "ip": "185.2.168.39" }
}
```

> ⚠️ **This is the most consequential gap in the whole document.** GSubz
> shows exactly one `/verify` outcome — a hard failure — and never shows
> what a **successful** verify looks like, nor what a **still-processing /
> pending** verify looks like, nor its status code. A poller cannot be built
> correctly against "one example of failure and nothing else." See §6 for
> what has to be assumed and confirmed by hand before this can be trusted in
> production.

`content.code: "016"` is the only service-level failure code GSubz documents
anywhere (`INSUFFICIENT_BALANCE`). The full enumeration of `content.code`
values is not published. Log every raw response the first weeks in
production and build the real table from what's actually observed, the same
way `content: 'transactionPoller' would need real traffic to enumerate
GSubz's actual `plan_status`-equivalent field.

### 3.8 `POST /balance`

**Request:**
```php
$data = array('api' => 'ap_xxxxxxxxxxxxxxxxxxx');
// CURLOPT_USERPWD => $username.":".$password   <- see warning below
```

**Response:**
```json
{ "response_description": "000", "content": { "balance": "841" } }
```

> ⚠️ **This example mixes two unrelated auth mechanisms and is not safe to
> copy as-is.** It sends the API key as a body field (`'api' => ...`) *and*
> sets `CURLOPT_USERPWD` (HTTP Basic auth with a username/password pair) —
> but `$username`/`$password` are never defined anywhere in the snippet.
> Every other endpoint in these docs authenticates purely via the
> `Authorization: Bearer` header. This example reads like a leftover from an
> older version of the API or a different auth scheme entirely, copy-pasted
> without being cleaned up. **Do not implement Basic auth for this
> endpoint** — call it with just the `Authorization: Bearer` header (as
> every other endpoint uses) and confirm balance still resolves; only reach
> for the body `api` field or Basic auth if the Bearer-only call is
> demonstrably rejected.
>
> Also note `response_description` here (not `status`/`code` like every
> other endpoint) — `/balance`'s response envelope doesn't match the shape
> used everywhere else in the API. Don't reuse a shared response parser
> across all endpoints without a branch for this one.
>
> `balance` is a **string** (`"841"`), like every price field in this API —
> parse before doing arithmetic.

## 4. Status code reference

**Top-level `status`/`code`** (the API-call-level result):

| `code` | `status` | Meaning |
|---|---|---|
| 200 | `TRANSACTION_SUCCESSFUL` | Call succeeded |
| 204 | `REQUIRED_CONTENT_NOT_SENT` | Missing required field(s) |
| 206 | `INVALID_CONTENT` | A field failed validation |
| 401 | `AUTHORIZATION_FAILED` | Bad/missing API key |
| 402 | `ERROR_IN_PAYMENT` | Payment-level failure (see `content.code`/`content.description` for the real reason — the `/verify` example above is a 402 with `INSUFFICIENT_BALANCE`) |
| 404 | `CONTENT_NOT_FOUND` | Unknown service/plan/requestID |
| 405 | `REQUEST_METHOD_NOT_IN_POST` | Wrong HTTP method |
| 406 | `NOT_ALLOWED` | — undocumented beyond the label |
| 502 | `GATEWAY_ERROR` | Upstream/gateway failure — see §6, this is exactly the ambiguous case that must never be treated as a confirmed failure |

**`content.code`** (service/purchase-level result) — only one value is
documented anywhere in these docs:

| `content.code` | Meaning |
|---|---|
| `"000"` | Purchase successful |
| `"016"` | `INSUFFICIENT_BALANCE` (GSubz's own wallet is short — not the customer's) |
| *(everything else)* | **Undocumented.** Must be discovered from real traffic. |

Nothing in the docs says which of the top-level codes are safe to retry and
which are terminal. Treat this as unknown and design for the worst case (see
§6).

## 5. Field & data-type notes (cross-cutting)

- **Phone numbers**: local format, no country code (`"0703xxxxxxxxxx"`).
  Confirm this holds for every network — the examples only show a couple of
  formats, always starting `0`.
- **Money fields are strings in every read endpoint** (`/plans`, `/variation`,
  `/balance`) but **numbers in `/pay`/`/verify` request and response**
  (`amount: 1000`, not `"1000"`). Don't assume one type across the whole API
  — check per field.
- **`requestID`** — GSubz's own examples generate it as `time() + mt_rand()`
  in PHP, producing wildly inconsistent lengths across their own examples
  (`897439437848`, `8755965695964845`, `3414793352` — 10 to 16 digits). There
  is no documented format contract beyond "unique per transaction." Generate
  it once, store it against the local transaction row *before* the network
  call goes out (matching how `requestId` is built as \`DATA_${Date.now()}\`
  in `ourdatastore.js`'s `executeBuyData`, for the same reason — the ID has
  to exist locally before the call so a lost response can still be
  reconciled by that ID afterward).
- **Content-Type — RESOLVED by live testing against `/api/testpay/`.**
  `application/x-www-form-urlencoded` and `multipart/form-data` both work and
  return a fully-formed success response. **A raw JSON body does NOT work** —
  it doesn't 400/415, it silently misreads the fields (a JSON body against
  `/api/testpay` returned `406 INVALID_ARGUMENTS_DUPLICATE_REQUEST_ID` for a
  brand-new, never-before-used `requestID`, meaning PHP's `$_POST` was empty
  and the server fell back to some default/cached value). **Use
  `application/x-www-form-urlencoded`** (`URLSearchParams`, not
  `JSON.stringify`) for `/pay` and `/verify` — do not reuse `ourdatastore.js`'s
  `Content-Type: application/json` pattern here.
- **Trailing slash is mandatory on POST endpoints — also found by live
  testing, and easy to get wrong silently.** `gsubz.com/api/testpay` (no
  trailing slash) 301-redirects to `gsubz.com/api/testpay/`, and per the
  `fetch`/browser redirect spec a 301 on a POST request is followed as a
  **GET** — so an un-slashed URL doesn't error, it just silently sends the
  wrong HTTP method and comes back `200 { code: "025",
  description: "REQUEST_METHOD_NOT_POST" }`, which reads exactly like a
  generic validation failure, not a URL bug. Confirmed identical on both
  `gsubz.com` and `api.gsubz.com`. **Always call `/api/pay/` and
  `/api/verify/` with the trailing slash already in the URL** — don't rely on
  an HTTP client to "follow the redirect correctly," since most clients
  (including Node's `fetch`) downgrade the method on 301/302 exactly like a
  browser would.
- **The sandbox pair is `/api/testpay/` + `/api/testverify/`, not
  `/api/testverfy/`.** The "testverfy" spelling elsewhere in GSubz's own docs
  (and earlier in this section) is itself a typo — `testverfy` 404s,
  `testverify` (full word) works. Confirmed live: `serviceID: "test_pay"` is
  the fixed sandbox service ID for `/testpay/` (any other serviceID against
  the sandbox 401s with `NOT_ALLOWED_SERVICE_ID_FOR_TEST_IS_(test_pay)`), and
  a `/testverify/` call against a `requestID` just created by `/testpay/`
  returns the **first real observed "success" verify response** for this
  integration (previously an open gap, see §6.2):
  ```json
  {
    "code": "200",
    "status": "TRANSACTION_SUCCESSFUL",
    "description": "TRANSACTION_SUCCESSFUL",
    "content": {
      "transactionID": "2623482075",
      "requestID": "SPIKE_...",
      "amount": "100",
      "phone": "08031234567",
      "serviceID": "test_pay",
      "email": "",
      "status": "TRANSACTION_SUCCESSFUL",
      "code": "200",
      "description": "TRANSACTION_SUCCESSFUL",
      "date": "2026-09-04T08:05:59+01:00"
    }
  }
  ```
  Two caveats before trusting this shape for the real endpoint: (1) the
  sandbox's `content.code` is `"200"`, not the `"000"` the real `/pay`
  example in §3.6 documents for a real successful purchase — trust `"000"`
  as the real-endpoint success check (and treat `content.status ===
  "TRANSACTION_SUCCESSFUL"` as a redundant confirming check, since that
  string was identical in both the sandbox and the real documented example);
  (2) this is still `/testverify/`, not `/verify/` — the *shape* generalizes,
  but §6.2's checklist item (capture a REAL `/verify` response from a real
  low-value purchase before launch) still stands.

## 6. Documentation gaps & production risks

This is the section that exists specifically to prevent a repeat of the
OurDataStore incident. For context on what actually happened there (from
`server/services/ourdatastore.js` and `server/services/transactionPoller.js`,
both already in this codebase):

> A purchase request to OurDataStore had **no timeout**, so when the
> connection hung, the calling code had no way to distinguish "the request
> never reached them" from "it reached them, succeeded, and the response
> just never came back." Treating that silence as a failure and refunding
> the customer's wallet — while the provider had, in fact, already delivered
> the data — is what put a user in a state where they were paid twice: once
> in data, once in a refund.

The fix already built for OurDataStore, and the pattern this document
recommends copying exactly for GSubz, has three parts:

1. **A `pending` status that is neither success nor failure.** A transaction
   that times out, or whose response is ambiguous, is marked `pending` —
   never refunded on the spot, never marked delivered on the spot.
2. **A poller that actively re-asks the provider** what really happened,
   before doing anything irreversible. `transactionPoller.js` re-queries
   OurDataStore for a pending transaction, and:
   - if the provider confirms delivery → mark success, **do not refund**,
     even though the original request looked like a failure;
   - if the provider confirms failure → refund;
   - if the provider is unreachable / gives no clear answer → **keep it
     pending** and try again later, rather than guessing;
   - only after a hard ceiling (2 hours, in the OurDataStore case) with
     still no confirmed delivery does it auto-refund — and even then, if the
     provider itself is unreachable at that point (not just "no delivery
     found," but genuinely unreachable), it holds for **manual review**
     instead of refunding blind.
3. **An idempotency guard on the refund path itself**
   (`refundAndFail`'s "wallet already credited (idempotency guard), skipping
   refund" check) — a second, independent line of defence so that even if
   the poller logic above is somehow triggered twice for the same
   transaction, the money only moves once.

Below is every specific gap in GSubz's documentation that makes this pattern
harder to build correctly, and what has to be done about each one before
launch.

### 6.1 No webhook / callback / IPN of any kind

Every other operation in this API is request/response; GSubz's docs mention
nothing that pushes a status change to you. That means **`/verify` is the
only source of truth**, and the poller's polling interval directly *is* the
system's worst-case delay between "the purchase actually finished" and "we
know about it." A short interval that hammers an undocumented rate limit
(§6.3) is itself a production risk; too long an interval leaves a transaction
looking pending to the customer for longer than necessary.

**Before launch:** confirm with GSubz directly whether a webhook/IPN exists
outside the public docs (many resellers keep one merchant-side-only and just
never publish it). If genuinely none exists, size the poll interval the same
deliberate way `transactionPoller.js` did for OurDataStore (`interval: 2
min`) — a real, considered choice — not an arbitrary number.

### 6.2 `/verify` never shows a "success" or "pending" response

Only one example exists in the entire doc, and it's a hard failure (§3.7).
Nothing shows:
- what `status`/`code`/`content.code` a **successful** purchase reports on
  verify (presumably mirrors `/pay`'s own success shape — `content.code:
  "000"` — but this is inference, not something the docs state);
- what a transaction that is **still being processed upstream** (the
  GSubz-side equivalent of OurDataStore's "plan_status 3 / not found yet, so
  leave pending") looks like at all. There may not even be a distinct
  "pending" status — the API might only ever answer success-or-failure and
  simply 404 (`CONTENT_NOT_FOUND`) for anything not yet resolved, which would
  make "not found" ambiguous between "never happened" and "not finished yet."

**Before launch:** deliberately trigger a real low-value purchase, call
`/verify` against it within the first second (before it can possibly have
completed), and record the *exact* raw response. That single observed
response is more trustworthy than anything inferable from these docs, and it
is the one piece of evidence needed to write the poller's "still processing"
branch correctly. Do this against `/api/testpay` +
`https://gsubz.com/api/testverfy` first — GSubz explicitly documents these as
a safe testing pair — before ever doing it against the live endpoints.

### 6.3 No rate limits published anywhere

OurDataStore's real production rate limit was only discovered by hitting it
(`Too Many Attempts.` / HTTP 429), which is why `ourdatastore.js` now runs
every purchase through a **serial queue** with a hard 1200ms minimum gap
between calls, plus exponential backoff (2s → 4s → 6s → 8s) specifically for
429s. GSubz gives no numbers at all.

**Before launch:** build the same serial-queue-with-backoff shape from day
one rather than waiting to get rate-limited in production first. It costs
nothing when traffic is low and is the only thing standing between "one busy
minute" and every purchase behind it silently queueing forever or erroring
out.

### 6.4 No idempotency contract on `requestID`

Nothing states what happens if the exact same `requestID` is POSTed to
`/pay` twice — does it return the original transaction's result (safe to
retry), silently create a second charge (unsafe), or reject the second call
outright (safe, but need to know how to detect that rejection)? This is the
single most important unknown for safe retry behaviour after a timeout,
since a timeout leaves you not knowing whether the first call actually
landed.

**Before launch:** test it directly — send one real low-value `/pay` call,
then immediately send the identical payload (same `requestID`) again, and
observe: two transactions, one, or a rejection. **Never retry a `/pay` call
with a fresh `requestID` after a timeout** until this is confirmed — a fresh
ID on retry is exactly how a single customer purchase becomes two
provider-side charges if the first request actually succeeded silently.

### 6.5 No documented distinction between retryable and terminal errors

The status table (§4) reads more like an HTTP-status analogy than an
operational guide. `502 GATEWAY_ERROR` is very plausibly transient and worth
a backoff-retry; `401 AUTHORIZATION_FAILED` never will be no matter how many
times it's retried; `402 ERROR_IN_PAYMENT` sits in between and depends
entirely on the `content.code`/`content.description` underneath it, which is
itself almost entirely undocumented (§4).

**Before launch:** build the retry policy around the *few* codes actually
confirmed by real traffic, default every unrecognised code to "treat as
pending, let the poller and a human sort it out" — the same fail-safe
default `transactionPoller.js` uses when OurDataStore itself is unreachable
— rather than guessing a longer allow-list of "safe to retry" codes upfront.

### 6.6 The `/pay` examples are mislabelled (repeated from §3.6 — critical enough to restate here)

The single easiest way this integration goes wrong on day one is trusting
the doc's own section headings over the actual field lists in each example.
Build the payload from `/fields` per service, never from copying either
worked example verbatim.

### 6.7 Price/amount trust boundary is unconfirmed

For a fixed-price service, does GSubz's server validate that the `amount`
sent in `/pay` actually matches the current price of the `plan` sent
alongside it, or does it trust the client-supplied `amount` outright? If the
latter, a client that resolves a stale/cached plan price (or a bug that
sends the wrong `amount` for the right `plan`) could purchase a bundle for
less than GSubz would charge — a real financial exposure, not a UX bug.

**Before launch:** send one real `/pay` call with a deliberately wrong
`amount` for a valid `plan` and see whether it's rejected or honoured. If
honoured, **always resolve `amount` server-side from a fresh `/plans` or
`/variation` call at the moment of purchase** — never trust a client-supplied
or cached amount for a fixed-price product.

## 7. Suggested integration shape for this codebase

This mirrors `server/services/ourdatastore.js`'s shape, adjusted for what's
actually different about GSubz:

- `server/services/gsubz.js` exposing `buyData`/`buyAirtime` (or a single
  `pay({ serviceID, ...fields })` given how GSubz itself unifies the
  endpoint), `verify(requestID)`, and `getBalance()`.
- No token-refresh logic needed (static key) — simpler than OurDataStore
  here, but log every use of the key and rotate it immediately if it's ever
  exposed in a log line, a client response, or a repo commit.
- The same serial request queue + backoff shape as `executeBuyData` (§6.3).
- A `requestID` built once per local transaction row, before the network
  call (§5), so a lost response is still reconciliable afterward.
- Reuse the **same `pending` → poller-reconciles → refund-only-on-confirmed-
  failure → idempotent refund guard** pipeline `transactionPoller.js` already
  runs for OurDataStore, rather than inventing a second, differently-shaped
  pipeline per provider. If Kabaku ends up running two providers side by
  side, the reconciliation *pattern* should be identical for both — only the
  provider-specific "ask them what happened" call underneath it should
  differ.
- Parse every string-typed money field (`price`, `balance`) before doing
  arithmetic on it (§5).
- A raw-response logger on `/pay` and `/verify` from the very first live
  call, kept for at least the first few weeks — this is how the undocumented
  parts of §4 and §6.2 actually get filled in with real data instead of
  guesses.

## 8. Pre-production checklist

- [ ] Confirmed real base URL is `https://gsubz.com/api/` for every endpoint
      (§2)
- [ ] Confirmed which GET endpoints truly need no `Authorization` header (§1)
- [x] Confirmed `/pay`/`/verify` expect `application/x-www-form-urlencoded`
      (JSON silently fails), and that POST URLs need a trailing slash or a
      301 redirect downgrades the POST to a GET — tested live against
      `/api/testpay/` and `/api/testverify/` (§5)
- [ ] Built the `/pay` payload from live `/fields` per service, not from
      either mislabelled worked example (§3.6, §6.6)
- [ ] Captured a real "still processing" `/verify` response and a real
      success `/verify` response against the LIVE (not sandbox) endpoint —
      the sandbox's `content.code: "200"` (vs. the real endpoint's
      documented `"000"`) is not proof enough on its own (§6.2, §5)
- [ ] Confirmed retry-with-same-`requestID` behaviour (§6.4) before any retry
      logic goes anywhere near production
- [ ] Confirmed whether `amount` is server-validated against `plan` for
      fixed-price services (§6.7)
- [ ] Asked GSubz directly whether an undocumented webhook/IPN exists (§6.1)
- [x] Serial queue + backoff in place from day one, not added after the
      first 429 (§6.3) — `server/services/gsubz.js`'s `buyData` mirrors
      `ourdatastore.js`'s queue/backoff exactly
- [x] `pending`-first, poller-reconciled, idempotency-guarded refund pipeline
      wired in, BUT deliberately conservative rather than "the exact shape
      that already protects OurDataStore purchases": `transactionPoller.js`
      flags a stuck GSubz transaction `_needsManualReview` at 30 minutes and
      never auto-refunds it (only ODS transactions get the automatic
      lookup-then-refund treatment) — because the two unconfirmed items
      right above this one (real `/pay` payload, real `/verify` responses)
      are exactly what that automatic path would need to be trustworthy.
      `gsubz.verify()` exists and is wired to a manual "Check GSubz status"
      admin action (flagged-transactions page) so there's still an
      ask-before-deciding tool today. Revisit once the two items above are
      checked off — the ODS-equivalent automatic path can then replace the
      manual-review one.
- [ ] Raw `/pay` and `/verify` responses logged from the first live
      transaction onward, to build the real `content.code` table (§4) —
      partially covered: `gsubz.js`'s `executeBuyData` already logs the full
      raw response via `logger.info('[GSUBZ PURCHASE] Response — ...')`
