/**
 * Lola One — fixture-based order-flow classifier.
 *
 * Reads fixtures/order-flow-cases.json, classifies each order's state,
 * flags the ones that need attention, and writes:
 *   - a console summary
 *   - output/classifications.json   (structured, for machines/dashboards)
 *   - output/triage-report.md       (plain-English, for non-technical owners)
 *
 * Run: npx tsx src/classify.ts
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AlertRouting,
  Classification,
  ClusterIncident,
  Fixture,
  FixtureOrder,
  FulfillmentOrder,
  Report,
  WarehousePollHealth,
} from './types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(HERE, '..', 'fixtures', 'order-flow-cases.json');
const OUTPUT_DIR = join(HERE, '..', 'output');

const ASSUMPTIONS: string[] = [
  '`generatedAt` is treated as "now"; all ages/SLAs are measured against it.',
  'An order is considered acknowledged by the WMS once ANY veracore-sourced lifecycle event exists (including `backordered` — the warehouse has seen the order even if it cannot ship it).',
  '`orders.createdAt` is used as the "paid" timestamp for the paid→fulfillment-order SLA; in this fixture the `paid` lifecycle event always matches `createdAt`.',
  'A warehouse whose Veracore order poll is `stale` cannot prove or disprove WMS silence: orders waiting on it are classified `unknown_limbo` (monitoring blind spot), not `wms_silent`, and the stale poll itself is raised as the incident. This avoids paging the fulfillment partner for what may be our own data pipeline.',
  'Two or more `wms_silent` orders at the same warehouse are folded into ONE cluster incident (one page, not N), since the shared warehouse is the likely root cause.',
  'Expected exceptions (holds, backorders, future-scheduled, presale before release+grace) are dashboard-only: visible, aging tracked, but nobody is paged.',
  'Presale orders breach only after `presaleReleaseAt` + `presaleShipGraceHours` with no shipment. Before that they are `presale_expected` even with no WMS activity.',
  'A cancelled/refunded order with WMS activity AFTER the cancellation was accepted is the most severe single-order state here (customer refunded but goods shipped), and always alerts immediately.',
  '`systemHealth.shopifyFulfillmentSync = healthy` means a WMS-shipped-but-Shopify-unfulfilled order is an order-level sync failure (Engineering), not a global outage.',
];

// ── time helpers ─────────────────────────────────────────────────

const MIN = 60_000;

function minutesBetween(earlier: string, later: string): number {
  return (new Date(later).getTime() - new Date(earlier).getTime()) / MIN;
}

function humanDuration(minutes: number): string {
  const m = Math.round(Math.abs(minutes));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

// ── classifier ───────────────────────────────────────────────────

class OrderClassifier {
  private readonly fixture: Fixture;
  private readonly now: string;
  private readonly pollByWarehouse: Map<string, WarehousePollHealth>;

  constructor(fixture: Fixture) {
    this.fixture = fixture;
    this.now = fixture.generatedAt;
    this.pollByWarehouse = new Map(
      fixture.systemHealth.veracoreOrderPollsByWarehouse.map((p) => [p.warehouse, p]),
    );
  }

  classifyAll(): Classification[] {
    return this.fixture.orders.map((o) => this.classify(o));
  }

  private classify(order: FixtureOrder): Classification {
    const rules = [
      this.checkCancelled,
      this.checkFulfilledHealthy,
      this.checkWmsShippedShopifyUnfulfilled,
      this.checkHold,
      this.checkBackordered,
      this.checkPresale,
      this.checkScheduled,
      this.checkMissingFulfillmentOrder,
      this.checkWmsSilence,
      this.checkInProgress,
    ];
    for (const rule of rules) {
      const result = rule.call(this, order);
      if (result) return result;
    }
    // Nothing matched: contradictory or unforeseen data shape.
    return this.result(order, {
      state: 'needs_human_review',
      flagged: true,
      reason: 'Order did not match any known healthy, expected-exception, or incident pattern.',
      staleOrInconsistentSystem: null,
      owner: 'Ops',
      nextAction: 'Review the order manually in Shopify admin and the Lola One order-detail dashboard.',
      alert: 'dashboard_only',
    });
  }

  // Rule 1: cancelled orders — clean cancel is fine; WMS activity after the
  // cancel was accepted means goods may ship to a refunded customer.
  private checkCancelled(order: FixtureOrder): Classification | null {
    if (!order.cancelledAt) return null;
    const postCancelWms = order.lifecycleEvents.filter(
      (e) => e.source === 'veracore' && e.at > order.cancelledAt!,
    );
    const shippedAfterCancel = postCancelWms.find((e) => e.state === 'shipped');
    if (shippedAfterCancel) {
      return this.result(order, {
        state: 'cancelled_but_wms_shipped',
        flagged: true,
        reason:
          `Order was cancelled and refunded in Shopify at ${order.cancelledAt}, the warehouse accepted the ` +
          `cancellation, but the WMS still reported it SHIPPED at ${shippedAfterCancel.at} — ` +
          `${humanDuration(minutesBetween(order.cancelledAt!, shippedAfterCancel.at))} after the cancel. ` +
          `A refunded customer is likely receiving product.`,
        staleOrInconsistentSystem:
          'Veracore/WMS (shipped after cancellation was accepted) — Shopify and WMS disagree about this order',
        owner: 'Ops',
        nextAction:
          `Contact the fulfillment partner (${this.warehouseOf(order)}) to intercept/recall the shipment or ` +
          `confirm it did not physically leave; check why the pick was not pulled after cancellation_accepted; ` +
          `if unrecoverable, decide on re-invoice vs write-off.`,
        alert: 'alert_immediately',
        notes: [`Order value at risk: $${order.totalPrice}.`],
      });
    }
    if (postCancelWms.length > 0) {
      return this.result(order, {
        state: 'needs_human_review',
        flagged: true,
        reason: `Order was cancelled but the WMS reported activity afterwards (${postCancelWms.map((e) => e.state).join(', ')}).`,
        staleOrInconsistentSystem: 'Veracore/WMS (activity after cancellation)',
        owner: 'Ops',
        nextAction: `Confirm with the fulfillment partner (${this.warehouseOf(order)}) that fulfillment is actually stopped.`,
        alert: 'alert_immediately',
      });
    }
    return this.result(order, {
      state: 'healthy',
      flagged: false,
      reason: 'Order was cancelled and the cancellation propagated cleanly (no WMS activity after cancel).',
      staleOrInconsistentSystem: null,
      owner: 'None',
      nextAction: 'None.',
      alert: 'none',
    });
  }

  // Rule 2: fulfilled end-to-end.
  private checkFulfilledHealthy(order: FixtureOrder): Classification | null {
    if (order.fulfillmentStatus !== 'fulfilled') return null;
    return this.result(order, {
      state: 'healthy',
      flagged: false,
      reason: 'Order completed the full path: paid → fulfillment order → WMS shipped → Shopify fulfilled.',
      staleOrInconsistentSystem: null,
      owner: 'None',
      nextAction: 'None.',
      alert: 'none',
    });
  }

  // Rule 3: WMS says shipped, Shopify still unfulfilled past SLA.
  private checkWmsShippedShopifyUnfulfilled(order: FixtureOrder): Classification | null {
    const shipped = order.lifecycleEvents.find((e) => e.source === 'veracore' && e.state === 'shipped');
    if (!shipped || order.fulfillmentStatus === 'fulfilled') return null;
    const lag = minutesBetween(shipped.at, this.now);
    const sla = this.fixture.slas.wmsShippedToShopifyFulfilledMinutes;
    if (lag <= sla) return null; // shipped very recently; sync may still land
    const foInconsistency = order.fulfillmentOrders.some(
      (fo) => fo.requestStatus === 'fulfilled' && order.fulfillments.length === 0,
    );
    return this.result(order, {
      state: 'wms_shipped_shopify_unfulfilled',
      flagged: true,
      reason:
        `WMS shipped this order ${humanDuration(lag)} ago but Shopify still shows it unfulfilled ` +
        `(SLA: ${sla}m). The customer has no tracking email and support/reporting see a stuck order.`,
      staleOrInconsistentSystem:
        'Shopify (stale — fulfillment not created despite WMS shipment' +
        (foInconsistency
          ? '; fulfillment order is marked fulfilled yet no fulfillment record exists, an internal Shopify inconsistency'
          : '') +
        ')',
      owner: 'Engineering',
      nextAction:
        'The fulfillment-sync job reports healthy overall, so treat this as an order-level sync failure: ' +
        'check sync logs for this order number, replay/create the fulfillment in Shopify with the WMS tracking data, ' +
        'and confirm the customer receives the shipping notification.',
      alert: 'alert_immediately',
      notes: ['Customer-facing impact: no shipping confirmation despite package being on its way.'],
    });
  }

  // Rule 4: active fulfillment hold — expected exception.
  private checkHold(order: FixtureOrder): Classification | null {
    const held = order.fulfillmentOrders.flatMap((fo) => fo.currentHolds);
    if (held.length === 0) return null;
    const hold = held[0];
    const age = minutesBetween(hold.placedAt, this.now);
    return this.result(order, {
      state: 'held_expected',
      flagged: true,
      reason:
        `Fulfillment is intentionally held: ${hold.reason} (placed by ${hold.heldByApp} ` +
        `${humanDuration(age)} ago). "${hold.reasonNotes}"`,
      staleOrInconsistentSystem: null,
      owner: 'Ops',
      nextAction:
        'Work the review queue: complete the manual fraud review and release or cancel the hold. ' +
        'Escalate if any hold ages past 24h — held inventory is unsellable limbo.',
      alert: 'dashboard_only',
      notes: [
        `Hold age ${humanDuration(age)}; risk level: ${order.riskLevel ?? 'n/a'}; value $${order.totalPrice}.`,
      ],
    });
  }

  // Rule 5: warehouse reported backordered — expected exception (WMS has acked).
  private checkBackordered(order: FixtureOrder): Classification | null {
    const backordered = [...order.lifecycleEvents]
      .reverse()
      .find((e) => e.source === 'veracore' && e.state === 'backordered');
    if (!backordered) return null;
    const shippedAfter = order.lifecycleEvents.some(
      (e) => e.source === 'veracore' && e.state === 'shipped' && e.at > backordered.at,
    );
    if (shippedAfter) return null; // recovered; let later rules judge
    const age = minutesBetween(backordered.at, this.now);
    return this.result(order, {
      state: 'backordered_expected',
      flagged: true,
      reason:
        `Warehouse acknowledged the order but reported it BACKORDERED ${humanDuration(age)} ago — ` +
        `blocked for an expected, known reason (no stock at ${this.warehouseOf(order)}).`,
      staleOrInconsistentSystem: null,
      owner: 'Ops',
      nextAction:
        'Confirm restock ETA with the fulfillment partner; if stock exists at another warehouse, ' +
        'consider moving the fulfillment order; notify the customer if the delay exceeds the shipping promise.',
      alert: 'dashboard_only',
      notes: [`Track backorder age; escalate to the fulfillment partner if it exceeds 48h without an ETA.`],
    });
  }

  // Rule 6: presale orders — expected before release(+grace), incident after.
  private checkPresale(order: FixtureOrder): Classification | null {
    const presaleItems = order.lineItems.filter((li) => li.presaleReleaseAt !== null);
    const isPresale = presaleItems.length > 0 || order.tags.includes('PresaleOrder');
    if (!isPresale) return null;

    const releaseAt = presaleItems
      .map((li) => li.presaleReleaseAt!)
      .sort()
      .at(-1); // latest release governs the whole order
    if (!releaseAt) return null;

    const graceMinutes = this.fixture.slas.presaleShipGraceHours * 60;
    const sinceRelease = minutesBetween(releaseAt, this.now);
    const hasShipped =
      order.fulfillments.length > 0 ||
      order.lifecycleEvents.some((e) => e.source === 'veracore' && e.state === 'shipped');

    if (sinceRelease <= 0) {
      return this.result(order, {
        state: 'presale_expected',
        flagged: false,
        reason:
          `Presale order (${presaleItems[0]?.sellingPlanName ?? 'presale plan'}); release date ` +
          `${releaseAt} is ${humanDuration(sinceRelease)} away. Waiting is the expected state.`,
        staleOrInconsistentSystem: null,
        owner: 'None',
        nextAction: 'None — will be re-evaluated after the release date.',
        alert: 'none',
      });
    }
    if (hasShipped || sinceRelease <= graceMinutes) {
      return this.result(order, {
        state: 'presale_expected',
        flagged: false,
        reason: `Presale released ${humanDuration(sinceRelease)} ago; within the ${this.fixture.slas.presaleShipGraceHours}h ship grace window.`,
        staleOrInconsistentSystem: null,
        owner: 'None',
        nextAction: 'None — monitor until shipped or grace expires.',
        alert: 'none',
      });
    }
    // Past release + grace with no shipment.
    const wmsAcked = order.lifecycleEvents.some((e) => e.source === 'veracore');
    return this.result(order, {
      state: 'presale_unexpected',
      flagged: true,
      reason:
        `Presale ship window (${presaleItems[0]?.sellingPlanName ?? releaseAt}) plus the ` +
        `${this.fixture.slas.presaleShipGraceHours}h grace period expired ` +
        `${humanDuration(sinceRelease - graceMinutes)} ago and nothing has shipped. ` +
        `The customer promise date has been missed.` +
        (wmsAcked ? '' : ` The warehouse (${this.warehouseOf(order)}) has never acknowledged the fulfillment order.`),
      staleOrInconsistentSystem: wmsAcked ? null : `Veracore/WMS (${this.warehouseOf(order)}) — silent since fulfillment order creation`,
      owner: 'Fulfillment partner',
      nextAction:
        `Ask ${this.warehouseOf(order)} why the released presale order has not been picked up; verify the ` +
        `fulfillment order actually reached their queue after release; Ops should prepare a customer delay comms if not shipping today.`,
      alert: 'alert_immediately',
      notes: order.tags.includes('Presale_Alert')
        ? ['Corroborated by the existing `Presale_Alert` tag from Shopify automation.']
        : [],
    });
  }

  // Rule 7: fulfillment deliberately scheduled for the future.
  private checkScheduled(order: FixtureOrder): Classification | null {
    const scheduled = order.fulfillmentOrders.find(
      (fo) => fo.scheduledAt && fo.scheduledAt > this.now,
    );
    if (!scheduled) return null;
    return this.result(order, {
      state: 'scheduled_expected',
      flagged: false,
      reason:
        `Fulfillment is deliberately scheduled for ${scheduled.scheduledAt} ` +
        `(${humanDuration(minutesBetween(this.now, scheduled.scheduledAt!))} from now)` +
        (order.tags.includes('DelayedShip') ? ', consistent with the DelayedShip tag' : '') +
        '. Waiting is the expected state.',
      staleOrInconsistentSystem: null,
      owner: 'None',
      nextAction: 'None — re-evaluate against SLAs after the scheduled time passes.',
      alert: 'none',
    });
  }

  // Rule 8: paid but no fulfillment order was ever created.
  private checkMissingFulfillmentOrder(order: FixtureOrder): Classification | null {
    if (order.fulfillmentOrders.length > 0) return null;
    const age = minutesBetween(order.createdAt, this.now);
    const sla = this.fixture.slas.shopifyPaidToFulfillmentOrderMinutes;
    if (age <= sla) {
      return this.result(order, {
        state: 'healthy_in_progress',
        flagged: false,
        reason: `Paid ${humanDuration(age)} ago; fulfillment order not created yet but within the ${sla}m SLA.`,
        staleOrInconsistentSystem: null,
        owner: 'None',
        nextAction: 'None.',
        alert: 'none',
      });
    }
    return this.result(order, {
      state: 'missing_fulfillment_order',
      flagged: true,
      reason:
        `Order was paid ${humanDuration(age)} ago but Shopify never created a fulfillment order ` +
        `(SLA: ${sla}m). No warehouse can see this order — it is invisible to fulfillment entirely.`,
      staleOrInconsistentSystem: 'Shopify (fulfillment order creation) — order exists, routing never happened',
      owner: 'Shopify/admin configuration',
      nextAction:
        'Check the order in Shopify admin for why routing failed (SKU missing from all location inventories, ' +
        'app hold at creation, or location routing rules). If the SKU/location setup is fine, escalate to ' +
        'Engineering to check for a dropped webhook or app error. Manually create/route the fulfillment order to unblock.',
      alert: 'alert_immediately',
      notes: ['Shopify webhooks and the ingestion queue report healthy, so this is not a Lola One data gap.'],
    });
  }

  // Rule 9: fulfillment order exists but the WMS has never acknowledged it.
  private checkWmsSilence(order: FixtureOrder): Classification | null {
    const wmsAcked = order.lifecycleEvents.some((e) => e.source === 'veracore');
    if (wmsAcked) return null;
    const fo = order.fulfillmentOrders[0];
    if (!fo) return null;
    const waiting = minutesBetween(fo.createdAt, this.now);
    const sla = this.fixture.slas.fulfillmentOrderToWmsAcknowledgeMinutes;
    if (waiting <= sla) return null; // still within expected processing time

    const warehouse = fo.assignedLocationName;
    const poll = this.pollByWarehouse.get(warehouse);

    if (poll && poll.status !== 'healthy') {
      // Our own visibility into this warehouse is broken; we cannot claim the WMS is silent.
      const pollAge = minutesBetween(poll.lastSuccessfulAt, this.now);
      return this.result(order, {
        state: 'unknown_limbo',
        flagged: true,
        reason:
          `No WMS acknowledgement for ${humanDuration(waiting)} (SLA: ${sla}m) — but Lola One's order-status ` +
          `poll for ${warehouse} has itself been stale for ${humanDuration(pollAge)}. We are blind, ` +
          `not necessarily blocked: the warehouse may be working this order and we cannot see it.`,
        staleOrInconsistentSystem: `Lola One's Veracore poll for ${warehouse} (monitoring blind spot) — WMS status unknown`,
        owner: 'Engineering',
        nextAction:
          `Fix or rerun the ${warehouse} order-status poll first (token expiry / poller error are the usual causes); ` +
          `once data flows, this order will auto-reclassify. Do NOT page the fulfillment partner yet — ` +
          `there is no evidence they are behind. If the poll cannot be restored quickly, have Ops confirm ` +
          `order status directly in the Veracore portal.`,
        alert: 'dashboard_only',
        notes: [
          'The stale poll itself is raised as an immediate system-level incident (see cluster incidents); this order rides on it.',
        ],
      });
    }

    return this.result(order, {
      state: 'wms_silent',
      flagged: true,
      reason:
        `Fulfillment order was routed to ${warehouse} ${humanDuration(waiting)} ago and the WMS has never ` +
        `acknowledged it (SLA: ${sla}m). Our poll for this warehouse is healthy, so the silence is real — ` +
        `the order genuinely has not started at the warehouse.`,
      staleOrInconsistentSystem: `Veracore/WMS (${warehouse}) — no acknowledgement since fulfillment order creation`,
      owner: 'Fulfillment partner',
      nextAction:
        `Confirm with ${warehouse} that the order is in their queue; verify the order export/handoff for this ` +
        `warehouse is running; if multiple orders are affected (see cluster incidents) treat it as a ` +
        `warehouse-level intake failure, not an order problem.`,
      alert: 'alert_immediately',
      notes: order.tags.length ? [`Tags: ${order.tags.join(', ')}.`] : [],
    });
  }

  // Rule 10: everything else that is progressing within SLA.
  private checkInProgress(order: FixtureOrder): Classification | null {
    const fo = order.fulfillmentOrders[0];
    if (!fo || fo.status !== 'open') return null;
    return this.result(order, {
      state: 'healthy_in_progress',
      flagged: false,
      reason: `Order is moving through the normal path and all SLA clocks are within bounds.`,
      staleOrInconsistentSystem: null,
      owner: 'None',
      nextAction: 'None.',
      alert: 'none',
    });
  }

  // ── helpers ────────────────────────────────────────────────────

  private warehouseOf(order: FixtureOrder): string {
    return order.fulfillmentOrders[0]?.assignedLocationName ?? 'unassigned';
  }

  private result(
    order: FixtureOrder,
    fields: Omit<Classification, 'orderNumber' | 'notes'> & { notes?: string[] },
  ): Classification {
    return { orderNumber: order.orderNumber, notes: [], ...fields };
  }
}

// ── cluster detection ────────────────────────────────────────────
// Fold correlated single-order flags into system-level incidents so a
// warehouse problem produces one page, not one page per order.

function detectClusters(fixture: Fixture, classifications: Classification[]): ClusterIncident[] {
  const clusters: ClusterIncident[] = [];
  const byOrder = new Map(fixture.orders.map((o) => [o.orderNumber, o]));

  // 1. wms_silent orders grouped by assigned warehouse.
  const silentByWarehouse = new Map<string, Classification[]>();
  for (const c of classifications) {
    if (c.state !== 'wms_silent') continue;
    const wh = byOrder.get(c.orderNumber)?.fulfillmentOrders[0]?.assignedLocationName ?? 'unknown';
    silentByWarehouse.set(wh, [...(silentByWarehouse.get(wh) ?? []), c]);
  }
  for (const [warehouse, members] of silentByWarehouse) {
    if (members.length < 2) continue;
    clusters.push({
      key: `wms-intake-failure:${warehouse}`,
      description:
        `${members.length} orders routed to ${warehouse} have all gone unacknowledged past SLA. ` +
        `This is a warehouse-level intake failure (likely the order feed into their WMS), not ${members.length} separate order problems.`,
      orderNumbers: members.map((m) => m.orderNumber),
      owner: 'Fulfillment partner',
      alert: 'alert_immediately',
      nextAction:
        `Raise ONE incident with ${warehouse}: confirm their order-import job is running and ask them to ` +
        `verify these order numbers are in their queue. Engineering should simultaneously confirm the ` +
        `fulfillment-order handoff for this warehouse succeeded on our side.`,
    });
    for (const m of members) {
      m.notes.push(`Part of cluster incident "${warehouse} intake failure" — alert once for the group, not per order.`);
    }
  }

  // 2. Stale warehouse polls = monitoring blind spots (system incident even with zero orders affected).
  for (const poll of fixture.systemHealth.veracoreOrderPollsByWarehouse) {
    if (poll.status === 'healthy') continue;
    const affected = classifications.filter(
      (c) =>
        c.state === 'unknown_limbo' &&
        byOrder.get(c.orderNumber)?.fulfillmentOrders[0]?.assignedLocationName === poll.warehouse,
    );
    clusters.push({
      key: `stale-poll:${poll.warehouse}`,
      description:
        `Lola One's Veracore order-status poll for ${poll.warehouse} is stale ` +
        `(last success ${poll.lastSuccessfulAt}). We currently have NO visibility into order progress at this ` +
        `warehouse; ${affected.length} order(s) are already in unknown limbo behind this blind spot.`,
      orderNumbers: affected.map((a) => a.orderNumber),
      owner: 'Engineering',
      alert: 'alert_immediately',
      nextAction:
        'Restore the poll (check Veracore API token expiry and poller logs). Until fixed, treat all ' +
        `"waiting on ${poll.warehouse}" orders as unverified rather than silent.`,
    });
  }

  return clusters;
}

// ── output rendering ─────────────────────────────────────────────

const ALERT_LABEL: Record<AlertRouting, string> = {
  alert_immediately: 'ALERT NOW',
  dashboard_only: 'dashboard',
  none: '—',
};

function renderConsole(report: Report): string {
  const lines: string[] = [];
  lines.push(`Order-flow classification — "now" = ${report.generatedAt}`);
  lines.push('');
  const pad = (s: string, n: number) => s.padEnd(n);
  lines.push(
    pad('ORDER', 9) + pad('STATE', 36) + pad('FLAG', 6) + pad('ROUTE', 11) + 'OWNER',
  );
  lines.push('-'.repeat(90));
  for (const c of report.classifications) {
    lines.push(
      pad(`#${c.orderNumber}`, 9) +
        pad(c.state, 36) +
        pad(c.flagged ? 'YES' : '', 6) +
        pad(ALERT_LABEL[c.alert], 11) +
        (c.owner === 'None' ? '' : c.owner),
    );
  }
  lines.push('');
  lines.push('Summary: ' + Object.entries(report.summary).map(([k, v]) => `${k}=${v}`).join('  '));
  lines.push('');
  for (const cl of report.clusters) {
    lines.push(`CLUSTER INCIDENT [${cl.owner}] ${cl.key}`);
    lines.push(`  ${cl.description}`);
    if (cl.orderNumbers.length) lines.push(`  Orders: ${cl.orderNumbers.map((o) => '#' + o).join(', ')}`);
    lines.push('');
  }
  return lines.join('\n');
}

function renderTriageMarkdown(report: Report): string {
  const md: string[] = [];
  md.push('# Order-Flow Triage Report');
  md.push('');
  md.push(`Evaluated as of **${report.generatedAt}** (fixture \`generatedAt\`).`);
  md.push('');
  const flagged = report.classifications.filter((c) => c.flagged);
  const immediate = flagged.filter((c) => c.alert === 'alert_immediately');
  const dashboard = flagged.filter((c) => c.alert === 'dashboard_only');
  const healthy = report.classifications.filter((c) => !c.flagged);
  md.push(
    `**${report.classifications.length} orders evaluated: ` +
      `${immediate.length} need someone now, ${dashboard.length} are expected exceptions to watch, ` +
      `${healthy.length} are healthy or progressing normally.**`,
  );
  md.push('');

  if (report.clusters.length) {
    md.push('## System-level incidents (page once per incident, not per order)');
    md.push('');
    for (const cl of report.clusters) {
      md.push(`### ${cl.key}`);
      md.push('');
      md.push(`- **What happened:** ${cl.description}`);
      if (cl.orderNumbers.length)
        md.push(`- **Orders affected:** ${cl.orderNumbers.map((o) => `#${o}`).join(', ')}`);
      md.push(`- **Owner:** ${cl.owner}`);
      md.push(`- **Next action:** ${cl.nextAction}`);
      md.push(`- **Alerting:** ${ALERT_LABEL[cl.alert]}`);
      md.push('');
    }
  }

  const section = (title: string, items: Classification[]) => {
    if (!items.length) return;
    md.push(`## ${title}`);
    md.push('');
    for (const c of items) {
      md.push(`### Order #${c.orderNumber} — \`${c.state}\``);
      md.push('');
      md.push(`- **Why flagged:** ${c.reason}`);
      if (c.staleOrInconsistentSystem)
        md.push(`- **Stale/inconsistent system:** ${c.staleOrInconsistentSystem}`);
      md.push(`- **Likely owner:** ${c.owner}`);
      md.push(`- **Suggested next action:** ${c.nextAction}`);
      md.push(`- **Alerting:** ${c.alert === 'alert_immediately' ? 'Alert immediately' : 'Dashboard only'}`);
      for (const n of c.notes) md.push(`- _${n}_`);
      md.push('');
    }
  };

  section('Real incidents — alert immediately', immediate);
  section('Expected exceptions — dashboard only', dashboard);

  md.push('## Healthy / progressing normally');
  md.push('');
  for (const c of healthy) md.push(`- **#${c.orderNumber}** — \`${c.state}\`: ${c.reason}`);
  md.push('');

  md.push('## Assumptions');
  md.push('');
  for (const a of report.assumptions) md.push(`- ${a}`);
  md.push('');
  return md.join('\n');
}

// ── main ─────────────────────────────────────────────────────────

function main() {
  const fixture: Fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
  const classifications = new OrderClassifier(fixture).classifyAll();
  const clusters = detectClusters(fixture, classifications);

  const summary: Record<string, number> = {};
  for (const c of classifications) summary[c.state] = (summary[c.state] ?? 0) + 1;

  const report: Report = {
    generatedAt: fixture.generatedAt,
    summary,
    clusters,
    classifications,
    assumptions: ASSUMPTIONS,
  };

  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(join(OUTPUT_DIR, 'classifications.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(OUTPUT_DIR, 'triage-report.md'), renderTriageMarkdown(report));
  console.log(renderConsole(report));
  console.log(`Wrote output/classifications.json and output/triage-report.md`);
}

main();
