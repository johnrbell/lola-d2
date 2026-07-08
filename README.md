# Deliverable 2 — Fixture-Based Order-Flow Classifier

A small TypeScript classifier that reads `fixtures/order-flow-cases.json`, classifies each order's state, and separates **real incidents** (someone gets paged) from **expected exceptions** (visible on a dashboard, nobody paged).

## How to run

```bash
npm install
npm run classify        # runs with plain Node (v23+, native TS type-stripping)
# or, on older Node:
npm run classify:tsx    # runs via tsx
npm run typecheck       # tsc --noEmit
```

Outputs:

- **Console** — one-line-per-order summary table plus cluster incidents.
- **`output/classifications.json`** — full structured report (per-order state, reason, stale/inconsistent system, owner, next action, alert routing, notes, plus cluster incidents and assumptions). This is the shape a dashboard or alerter would consume.
- **`output/triage-report.md`** — the same content written in plain English for non-technical owners, grouped into: system-level incidents, alert-immediately orders, dashboard-only exceptions, and healthy orders.

## How classification works

Each order is evaluated against rules in precedence order — most severe / most specific first. `generatedAt` is "now"; the fixture's `slas` and `systemHealth` drive every judgment.

| Priority | Rule | State | Route |
|---|---|---|---|
| 1 | Cancelled in Shopify, but WMS reported activity/shipment *after* the cancellation was accepted | `cancelled_but_wms_shipped` | Alert now |
| 2 | Shopify shows fulfilled | `healthy` | — |
| 3 | WMS shipped > `wmsShippedToShopifyFulfilledMinutes` ago, Shopify still unfulfilled | `wms_shipped_shopify_unfulfilled` | Alert now |
| 4 | Active fulfillment hold (e.g. fraud review) | `held_expected` | Dashboard |
| 5 | WMS reported backordered (and hasn't shipped since) | `backordered_expected` | Dashboard |
| 6 | Presale item: release in future, or within `presaleShipGraceHours` after release | `presale_expected` | — |
| 6b | Presale release + grace expired with no shipment | `presale_unexpected` | Alert now |
| 7 | Fulfillment deliberately scheduled for the future | `scheduled_expected` | — |
| 8 | Paid > `shopifyPaidToFulfillmentOrderMinutes` ago, no fulfillment order exists | `missing_fulfillment_order` | Alert now |
| 9 | Fulfillment order unacknowledged by WMS past `fulfillmentOrderToWmsAcknowledgeMinutes` — and our poll for that warehouse is **healthy** | `wms_silent` | Alert now |
| 9b | Same, but our poll for that warehouse is **stale** | `unknown_limbo` | Dashboard (the stale poll itself alerts) |
| 10 | Everything else within SLA | `healthy_in_progress` | — |
| fallback | Nothing matched | `needs_human_review` | Dashboard |

### The two judgment calls that matter most

**1. Silence vs blindness (orders #900201–03 vs #900701).** Three orders at Jillamy TX are unacknowledged past SLA while our Jillamy poll is healthy — that silence is *real*, and it's the warehouse's problem. Order #900701 at Landis PA is also unacknowledged past SLA, but our Landis poll has been stale for ~2h — we can't tell whether the warehouse is behind or whether we just can't see. So #900701 is `unknown_limbo`, the page goes to **Engineering to fix the poll** (not to the fulfillment partner), and the order auto-reclassifies once data flows again. Paging a 3PL with no evidence burns trust fast.

**2. One incident, not N alerts.** The three Jillamy orders share a warehouse and a failure mode, so they're folded into a single cluster incident ("Jillamy intake failure") — one page with three order numbers attached, instead of three pages that make the on-call person diagnose the same root cause three times.

## Assumptions

1. `generatedAt` is "now"; all ages and SLA breaches are measured against it.
2. **Any** veracore-sourced lifecycle event counts as WMS acknowledgement — including `backordered`, since the warehouse has clearly seen the order even if it can't ship it.
3. `orders.createdAt` is the "paid" timestamp for the paid→fulfillment-order SLA (matches the `paid` lifecycle event throughout this fixture).
4. A stale warehouse poll means we treat waiting orders as *unverified* (`unknown_limbo`), never as proven `wms_silent`. Monitoring blind spots are Engineering incidents; warehouse silence is a Fulfillment-partner incident.
5. ≥2 `wms_silent` orders at one warehouse collapse into a single cluster incident.
6. Expected exceptions (holds, backorders, scheduled, presale-in-window) are dashboard-only, with aging notes for escalation (e.g. holds >24h, backorders >48h without an ETA).
7. Presale orders only breach after `presaleReleaseAt` + `presaleShipGraceHours` with nothing shipped; the latest release date on the order governs.
8. `shopifyFulfillmentSync: healthy` in `systemHealth` means a WMS-shipped-but-Shopify-unfulfilled order is an order-level failure (Engineering), not a global sync outage.
9. Severity of `cancelled_but_wms_shipped` is the highest single-order tier: a refunded customer receiving goods is both a financial loss and a support problem, and it's time-critical (interception window).

## Results on this fixture

14 orders → 7 alert-now, 3 dashboard-only exceptions, 4 healthy/in-progress, plus 2 system-level cluster incidents:

```
#900101  healthy                          #900501  presale_expected
#900102  healthy_in_progress              #900502  presale_unexpected        ALERT
#900103  missing_fulfillment_order  ALERT #900601  backordered_expected      dash
#900201  wms_silent (cluster)       ALERT #900701  unknown_limbo             dash*
#900202  wms_silent (cluster)       ALERT #900801  cancelled_but_wms_shipped ALERT
#900203  wms_silent (cluster)       ALERT
#900301  wms_shipped_shopify_unfulfilled ALERT
#900401  held_expected              dash
#900402  scheduled_expected

* the stale Landis PA poll behind #900701 raises its own immediate Engineering alert
```

See `output/triage-report.md` for the full plain-English writeup per order.

## Project layout

```
fixtures/order-flow-cases.json   provided fixture (unmodified)
src/types.ts                     fixture + report type definitions
src/classify.ts                  classifier rules, cluster detection, report rendering
output/                          generated on each run
```
