# Removing the temporary "Temp" audit tab

The **Temp** tab in the admin sidebar exists for a one-off short-delivery review
with management. Nothing else in the application depends on it. To take it down:

## 1. Delete these files

```
server/services/shortDeliveryAudit.js
server/models/TempShortDeliveryModel.js
server/controllers/adminControllers/tempAuditController.js
server/routes/adminRoutes/tempAuditRoute.js
views/adminview/temp.ejs
scripts/audit-short-delivery.js          # the CLI version of the same audit
TEMP-AUDIT-REMOVAL.md                    # this file
```

## 2. Remove the route mount

In `app.js`, delete:

```js
// TEMPORARY — short-delivery audit for management review. See TEMP-AUDIT-REMOVAL.md
app.use('/admin/temp',                 require('./server/routes/adminRoutes/tempAuditRoute'));
```

## 3. Remove the sidebar link

In `views/partials/sideMenuAdmin.ejs`, delete the block marked
`<!-- TEMPORARY — remove with the short-delivery audit -->` (the `/admin/temp`
list item).

## 4. Drop the snapshot collection

```js
db.tempshortdeliveries.drop()
```

Holds only cached audit results — no customer or financial records.

---

## What the audit found (snapshot taken 2026-08-24)

| | |
|---|---|
| Short-delivered transactions | **9** |
| Customers affected | **8** |
| Data not delivered | **45GB** |
| Value not delivered | **₦14,935** |
| Total paid on affected orders | ₦37,900 |

## How it detects short delivery

OurDataStore splits large bundles into 5GB legs. When a leg fails it still
returns `plan_status: 1`, and the message we store still claims the full amount
was shared — so **nothing on our side reveals it**.

The only signal is the `api_response` field on the OurDataStore record:

```
"Hello Chief! 1 Failed 2 Successful and 0 Unsure out of the transactions"
```

Their `transid` equals our `apiResponse.requestId`, so the two sides join on a
key rather than a fuzzy phone + time window. Delivered volume is taken as
proportional to successful legs, which matches the observed 5GB granularity
(15GB = 3 legs; 2 successful = 10GB).

## Coverage limits — read before quoting the totals

- **2,428 of 3,120** successful transactions were checked.
- **692 could not be checked**: they have no `requestId` stored, so there is no
  key to match against OurDataStore. Short deliveries among them would not
  appear in this table.
- OurDataStore's history holds ~4,745 records. Anything older than their
  retention window cannot be verified at all.

The ₦14,935 is therefore a **floor, not a total**.
