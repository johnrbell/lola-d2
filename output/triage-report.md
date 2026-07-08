# Order-Flow Triage Report

Evaluated as of **2026-05-01T12:00:00Z** (fixture `generatedAt`).

**14 orders evaluated: 7 need someone now, 3 are expected exceptions to watch, 4 are healthy or progressing normally.**

## System-level incidents (page once per incident, not per order)

### wms-intake-failure:Jillamy Fulfillment - Texas

- **What happened:** 3 orders routed to Jillamy Fulfillment - Texas have all gone unacknowledged past SLA. This is a warehouse-level intake failure (likely the order feed into their WMS), not 3 separate order problems.
- **Orders affected:** #900201, #900202, #900203
- **Owner:** Fulfillment partner
- **Next action:** Raise ONE incident with Jillamy Fulfillment - Texas: confirm their order-import job is running and ask them to verify these order numbers are in their queue. Engineering should simultaneously confirm the fulfillment-order handoff for this warehouse succeeded on our side.
- **Alerting:** ALERT NOW

### stale-poll:Landis Logistics - Pennsylvania

- **What happened:** Lola One's Veracore order-status poll for Landis Logistics - Pennsylvania is stale (last success 2026-05-01T10:05:00Z). We currently have NO visibility into order progress at this warehouse; 1 order(s) are already in unknown limbo behind this blind spot.
- **Orders affected:** #900701
- **Owner:** Engineering
- **Next action:** Restore the poll (check Veracore API token expiry and poller logs). Until fixed, treat all "waiting on Landis Logistics - Pennsylvania" orders as unverified rather than silent.
- **Alerting:** ALERT NOW

## Real incidents — alert immediately

### Order #900103 — `missing_fulfillment_order`

- **Why flagged:** Order was paid 1h 20m ago but Shopify never created a fulfillment order (SLA: 30m). No warehouse can see this order — it is invisible to fulfillment entirely.
- **Stale/inconsistent system:** Shopify (fulfillment order creation) — order exists, routing never happened
- **Likely owner:** Shopify/admin configuration
- **Suggested next action:** Check the order in Shopify admin for why routing failed (SKU missing from all location inventories, app hold at creation, or location routing rules). If the SKU/location setup is fine, escalate to Engineering to check for a dropped webhook or app error. Manually create/route the fulfillment order to unblock.
- **Alerting:** Alert immediately
- _Shopify webhooks and the ingestion queue report healthy, so this is not a Lola One data gap._

### Order #900201 — `wms_silent`

- **Why flagged:** Fulfillment order was routed to Jillamy Fulfillment - Texas 3h 45m ago and the WMS has never acknowledged it (SLA: 60m). Our poll for this warehouse is healthy, so the silence is real — the order genuinely has not started at the warehouse.
- **Stale/inconsistent system:** Veracore/WMS (Jillamy Fulfillment - Texas) — no acknowledgement since fulfillment order creation
- **Likely owner:** Fulfillment partner
- **Suggested next action:** Confirm with Jillamy Fulfillment - Texas that the order is in their queue; verify the order export/handoff for this warehouse is running; if multiple orders are affected (see cluster incidents) treat it as a warehouse-level intake failure, not an order problem.
- **Alerting:** Alert immediately
- _Tags: PeakSale._
- _Part of cluster incident "Jillamy Fulfillment - Texas intake failure" — alert once for the group, not per order._

### Order #900202 — `wms_silent`

- **Why flagged:** Fulfillment order was routed to Jillamy Fulfillment - Texas 3h 36m ago and the WMS has never acknowledged it (SLA: 60m). Our poll for this warehouse is healthy, so the silence is real — the order genuinely has not started at the warehouse.
- **Stale/inconsistent system:** Veracore/WMS (Jillamy Fulfillment - Texas) — no acknowledgement since fulfillment order creation
- **Likely owner:** Fulfillment partner
- **Suggested next action:** Confirm with Jillamy Fulfillment - Texas that the order is in their queue; verify the order export/handoff for this warehouse is running; if multiple orders are affected (see cluster incidents) treat it as a warehouse-level intake failure, not an order problem.
- **Alerting:** Alert immediately
- _Tags: PeakSale._
- _Part of cluster incident "Jillamy Fulfillment - Texas intake failure" — alert once for the group, not per order._

### Order #900203 — `wms_silent`

- **Why flagged:** Fulfillment order was routed to Jillamy Fulfillment - Texas 3h 33m ago and the WMS has never acknowledged it (SLA: 60m). Our poll for this warehouse is healthy, so the silence is real — the order genuinely has not started at the warehouse.
- **Stale/inconsistent system:** Veracore/WMS (Jillamy Fulfillment - Texas) — no acknowledgement since fulfillment order creation
- **Likely owner:** Fulfillment partner
- **Suggested next action:** Confirm with Jillamy Fulfillment - Texas that the order is in their queue; verify the order export/handoff for this warehouse is running; if multiple orders are affected (see cluster incidents) treat it as a warehouse-level intake failure, not an order problem.
- **Alerting:** Alert immediately
- _Tags: PeakSale._
- _Part of cluster incident "Jillamy Fulfillment - Texas intake failure" — alert once for the group, not per order._

### Order #900301 — `wms_shipped_shopify_unfulfilled`

- **Why flagged:** WMS shipped this order 1h 10m ago but Shopify still shows it unfulfilled (SLA: 30m). The customer has no tracking email and support/reporting see a stuck order.
- **Stale/inconsistent system:** Shopify (stale — fulfillment not created despite WMS shipment; fulfillment order is marked fulfilled yet no fulfillment record exists, an internal Shopify inconsistency)
- **Likely owner:** Engineering
- **Suggested next action:** The fulfillment-sync job reports healthy overall, so treat this as an order-level sync failure: check sync logs for this order number, replay/create the fulfillment in Shopify with the WMS tracking data, and confirm the customer receives the shipping notification.
- **Alerting:** Alert immediately
- _Customer-facing impact: no shipping confirmation despite package being on its way._

### Order #900502 — `presale_unexpected`

- **Why flagged:** Presale ship window (Preorder - Apr 29 Ship Window) plus the 24h grace period expired 22h 0m ago and nothing has shipped. The customer promise date has been missed. The warehouse (Elevate Fulfillment - Idaho) has never acknowledged the fulfillment order.
- **Stale/inconsistent system:** Veracore/WMS (Elevate Fulfillment - Idaho) — silent since fulfillment order creation
- **Likely owner:** Fulfillment partner
- **Suggested next action:** Ask Elevate Fulfillment - Idaho why the released presale order has not been picked up; verify the fulfillment order actually reached their queue after release; Ops should prepare a customer delay comms if not shipping today.
- **Alerting:** Alert immediately
- _Corroborated by the existing `Presale_Alert` tag from Shopify automation._

### Order #900801 — `cancelled_but_wms_shipped`

- **Why flagged:** Order was cancelled and refunded in Shopify at 2026-05-01T08:40:00Z, the warehouse accepted the cancellation, but the WMS still reported it SHIPPED at 2026-05-01T09:10:00Z — 30m after the cancel. A refunded customer is likely receiving product.
- **Stale/inconsistent system:** Veracore/WMS (shipped after cancellation was accepted) — Shopify and WMS disagree about this order
- **Likely owner:** Ops
- **Suggested next action:** Contact the fulfillment partner (Jillamy Fulfillment - Texas) to intercept/recall the shipment or confirm it did not physically leave; check why the pick was not pulled after cancellation_accepted; if unrecoverable, decide on re-invoice vs write-off.
- **Alerting:** Alert immediately
- _Order value at risk: $196.00._

## Expected exceptions — dashboard only

### Order #900401 — `held_expected`

- **Why flagged:** Fulfillment is intentionally held: HIGH_RISK_OF_FRAUD (placed by Shopify Flow 4h 18m ago). "Manual review required before release."
- **Likely owner:** Ops
- **Suggested next action:** Work the review queue: complete the manual fraud review and release or cancel the hold. Escalate if any hold ages past 24h — held inventory is unsellable limbo.
- **Alerting:** Dashboard only
- _Hold age 4h 18m; risk level: high; value $488.00._

### Order #900601 — `backordered_expected`

- **Why flagged:** Warehouse acknowledged the order but reported it BACKORDERED 26h 0m ago — blocked for an expected, known reason (no stock at Elevate Fulfillment - Idaho).
- **Likely owner:** Ops
- **Suggested next action:** Confirm restock ETA with the fulfillment partner; if stock exists at another warehouse, consider moving the fulfillment order; notify the customer if the delay exceeds the shipping promise.
- **Alerting:** Dashboard only
- _Track backorder age; escalate to the fulfillment partner if it exceeds 48h without an ETA._

### Order #900701 — `unknown_limbo`

- **Why flagged:** No WMS acknowledgement for 2h 10m (SLA: 60m) — but Lola One's order-status poll for Landis Logistics - Pennsylvania has itself been stale for 1h 55m. We are blind, not necessarily blocked: the warehouse may be working this order and we cannot see it.
- **Stale/inconsistent system:** Lola One's Veracore poll for Landis Logistics - Pennsylvania (monitoring blind spot) — WMS status unknown
- **Likely owner:** Engineering
- **Suggested next action:** Fix or rerun the Landis Logistics - Pennsylvania order-status poll first (token expiry / poller error are the usual causes); once data flows, this order will auto-reclassify. Do NOT page the fulfillment partner yet — there is no evidence they are behind. If the poll cannot be restored quickly, have Ops confirm order status directly in the Veracore portal.
- **Alerting:** Dashboard only
- _The stale poll itself is raised as an immediate system-level incident (see cluster incidents); this order rides on it._

## Healthy / progressing normally

- **#900101** — `healthy`: Order completed the full path: paid → fulfillment order → WMS shipped → Shopify fulfilled.
- **#900102** — `healthy_in_progress`: Order is moving through the normal path and all SLA clocks are within bounds.
- **#900402** — `scheduled_expected`: Fulfillment is deliberately scheduled for 2026-05-03T15:00:00Z (2d 3h from now), consistent with the DelayedShip tag. Waiting is the expected state.
- **#900501** — `presale_expected`: Presale order (Preorder - May 15 Ship Window); release date 2026-05-15T14:00:00Z is 14d 2h away. Waiting is the expected state.

## Assumptions

- `generatedAt` is treated as "now"; all ages/SLAs are measured against it.
- An order is considered acknowledged by the WMS once ANY veracore-sourced lifecycle event exists (including `backordered` — the warehouse has seen the order even if it cannot ship it).
- `orders.createdAt` is used as the "paid" timestamp for the paid→fulfillment-order SLA; in this fixture the `paid` lifecycle event always matches `createdAt`.
- A warehouse whose Veracore order poll is `stale` cannot prove or disprove WMS silence: orders waiting on it are classified `unknown_limbo` (monitoring blind spot), not `wms_silent`, and the stale poll itself is raised as the incident. This avoids paging the fulfillment partner for what may be our own data pipeline.
- Two or more `wms_silent` orders at the same warehouse are folded into ONE cluster incident (one page, not N), since the shared warehouse is the likely root cause.
- Expected exceptions (holds, backorders, future-scheduled, presale before release+grace) are dashboard-only: visible, aging tracked, but nobody is paged.
- Presale orders breach only after `presaleReleaseAt` + `presaleShipGraceHours` with no shipment. Before that they are `presale_expected` even with no WMS activity.
- A cancelled/refunded order with WMS activity AFTER the cancellation was accepted is the most severe single-order state here (customer refunded but goods shipped), and always alerts immediately.
- `systemHealth.shopifyFulfillmentSync = healthy` means a WMS-shipped-but-Shopify-unfulfilled order is an order-level sync failure (Engineering), not a global outage.
