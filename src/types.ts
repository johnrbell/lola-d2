/** Shape of fixtures/order-flow-cases.json */

export interface Fixture {
  fixtureVersion: string;
  generatedAt: string;
  slas: Slas;
  locations: Location[];
  systemHealth: SystemHealth;
  orders: FixtureOrder[];
}

export interface Slas {
  shopifyPaidToFulfillmentOrderMinutes: number;
  fulfillmentOrderToWmsAcknowledgeMinutes: number;
  wmsShippedToShopifyFulfilledMinutes: number;
  presaleShipGraceHours: number;
}

export interface Location {
  name: string;
  type: string;
  shopifyLocationId: string | null;
  veracoreSystemId: string;
  veracoreWarehouseId: string | null;
}

export interface SystemHealth {
  shopifyWebhooks: { status: string; lastReceivedAt: string };
  webhookQueue: { status: string; waiting: number; active: number; failed: number };
  shopifyFulfillmentSync: { status: string; lastSuccessfulAt: string };
  veracoreOrderPollsByWarehouse: WarehousePollHealth[];
}

export interface WarehousePollHealth {
  warehouse: string;
  status: 'healthy' | 'stale' | string;
  lastSuccessfulAt: string;
  notes?: string;
}

export interface FixtureOrder {
  orderNumber: string;
  name: string;
  createdAt: string;
  financialStatus: string;
  fulfillmentStatus: string;
  cancelledAt: string | null;
  closedAt: string | null;
  tags: string[];
  riskLevel: string | null;
  totalPrice: string;
  lineItems: LineItem[];
  fulfillmentOrders: FulfillmentOrder[];
  fulfillments: Fulfillment[];
  lifecycleEvents: LifecycleEvent[];
}

export interface LineItem {
  sku: string;
  quantity: number;
  sellingPlanName: string | null;
  presaleReleaseAt: string | null;
}

export interface FulfillmentOrder {
  id: string;
  status: string;
  requestStatus: string;
  assignedLocationName: string;
  createdAt: string;
  updatedAt: string;
  scheduledAt: string | null;
  currentHolds: FulfillmentHold[];
}

export interface FulfillmentHold {
  id: string;
  reason: string;
  reasonNotes: string;
  heldByApp: string;
  heldByRequestingApp: boolean;
  placedAt: string;
}

export interface Fulfillment {
  id: string;
  status: string;
  createdAt: string;
  trackingCompany: string;
  trackingNumber: string;
}

export interface LifecycleEvent {
  at: string;
  source: 'shopify' | 'veracore' | string;
  state: string;
}

/** Classifier output */

export type OrderState =
  | 'healthy'
  | 'healthy_in_progress'
  | 'missing_fulfillment_order'
  | 'wms_silent'
  | 'wms_shipped_shopify_unfulfilled'
  | 'held_expected'
  | 'scheduled_expected'
  | 'backordered_expected'
  | 'presale_expected'
  | 'presale_unexpected'
  | 'cancelled_but_wms_shipped'
  | 'unknown_limbo'
  | 'needs_human_review';

export type Owner =
  | 'Ops'
  | 'Engineering'
  | 'Fulfillment partner'
  | 'ERP/data partner'
  | 'Shopify/admin configuration'
  | 'None';

export type AlertRouting = 'alert_immediately' | 'dashboard_only' | 'none';

export interface Classification {
  orderNumber: string;
  state: OrderState;
  flagged: boolean;
  /** Why the order was flagged (or why it is considered fine). */
  reason: string;
  /** Which system appears stale or inconsistent, if any. */
  staleOrInconsistentSystem: string | null;
  /** Who should pick this up. */
  owner: Owner;
  /** What to do next, written for the owner. */
  nextAction: string;
  alert: AlertRouting;
  /** Extra context, e.g. SLA numbers, cluster membership, caveats. */
  notes: string[];
}

export interface ClusterIncident {
  key: string;
  description: string;
  orderNumbers: string[];
  owner: Owner;
  alert: AlertRouting;
  nextAction: string;
}

export interface Report {
  generatedAt: string;
  summary: Record<string, number>;
  clusters: ClusterIncident[];
  classifications: Classification[];
  assumptions: string[];
}
