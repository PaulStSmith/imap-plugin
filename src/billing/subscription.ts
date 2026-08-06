import { readOrCreateInstallation } from "../config/installation.js";
import { hasSqlConnectionString } from "../config/sql.js";
import {
  readInstallationEntitlement,
  readInstallationEntitlementBySubscription,
  upsertInstallationEntitlement
} from "./installation-entitlements.js";

export type PaidFeature = "mail_actions";

export interface SubscriptionStatus {
  feature: PaidFeature;
  live: boolean;
  status: string;
  plansUrl: string;
  paymentUrl: string;
  provider: "installation" | "env";
  installation?: {
    installationId: string;
    productId: string;
    createdAt: string;
    customerId?: string;
    subscriptionId?: string;
    validUntil?: string;
  };
  error?: string;
}

export interface SubscriptionRequired {
  ok: false;
  code: "subscription_required";
  requiresSubscription: true;
  feature: PaidFeature;
  action: string;
  message: string;
  installation: {
    installationId: string;
    productId: string;
    createdAt: string;
  };
  plansUrl: string;
  paymentUrl: string;
}

export interface ActivationResult {
  ok: boolean;
  code?: "entitlement_db_not_configured" | "stripe_not_configured" | "stripe_error" | "subscription_not_live" | "subscription_price_mismatch";
  message: string;
  installation: {
    installationId: string;
    productId: string;
    createdAt: string;
  };
  subscription?: SubscriptionStatus;
  stripe?: {
    subscriptionId: string;
    customerId?: string;
    status?: string;
    validUntil?: string;
  };
}

export interface EntitlementSyncResult {
  ok: boolean;
  action: "updated" | "ignored";
  reason?: string;
  entitlement?: {
    installationId: string;
    feature: PaidFeature;
    status: string;
    customerId?: string;
    subscriptionId?: string;
    validUntil?: string;
  };
}

const DEFAULT_PLANS_URL = "https://paulstsmith.github.io/imap-plugin/#plans";
const DEFAULT_MAIL_ACTIONS_PRICE_ID = "price_1U0jfRLELPI0KuVFShRkU2tv";
const DEFAULT_MAIL_ACTIONS_PRICE_IDS = [
  DEFAULT_MAIL_ACTIONS_PRICE_ID,
  "price_1U1QfyLELPI0KuVFjy08cLuI"
];
const LIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing", "lifetime"]);
const STRIPE_API_BASE_URL = "https://api.stripe.com/v1";

interface StripeSubscriptionItem {
  price?: {
    id?: string;
  };
}

interface StripeSubscription {
  id: string;
  status: string;
  customer?: string | { id?: string };
  current_period_end?: number;
  items?: {
    data?: StripeSubscriptionItem[];
  };
}

interface StripeCheckoutSession {
  id: string;
  object: "checkout.session";
  mode?: "payment" | "setup" | "subscription";
  status?: string;
  payment_status?: string;
  customer?: string | { id?: string };
  subscription?: string | { id?: string };
  payment_intent?: string | { id?: string };
  metadata?: Record<string, string>;
  custom_fields?: Array<{
    key?: string;
    text?: {
      value?: string | null;
    };
  }>;
}

export interface StripeWebhookEvent {
  id: string;
  type: string;
  data?: {
    object?: unknown;
  };
}

function envValue(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) {
      return value;
    }
  }

  return undefined;
}

async function installationStatus(feature: PaidFeature): Promise<SubscriptionStatus> {
  const installation = await readOrCreateInstallation();
  if (!hasSqlConnectionString()) {
    return {
      feature,
      live: false,
      status: "entitlement_db_not_configured",
      plansUrl: plansUrl(),
      paymentUrl: plansUrl(),
      provider: "installation",
      installation: {
        installationId: installation.installationId,
        productId: installation.productId,
        createdAt: installation.createdAt
      }
    };
  }

  const entitlement = await readInstallationEntitlement(installation.installationId, feature);
  const status = entitlement?.status.toLowerCase() || "none";
  const validUntil = entitlement?.validUntil ? Date.parse(entitlement.validUntil) : undefined;
  const live = LIVE_SUBSCRIPTION_STATUSES.has(status) && (!validUntil || validUntil > Date.now());

  return {
    feature,
    live,
    status: live ? status : status === "none" ? "installation_not_entitled" : status,
    plansUrl: plansUrl(),
    paymentUrl: plansUrl(),
    provider: "installation",
    installation: {
      installationId: installation.installationId,
      productId: installation.productId,
      createdAt: installation.createdAt,
      customerId: entitlement?.customerId,
      subscriptionId: entitlement?.subscriptionId,
      validUntil: entitlement?.validUntil
    }
  };
}

export function plansUrl(): string {
  return envValue("IMAP_PLUGIN_PLANS_URL") || DEFAULT_PLANS_URL;
}

export function paymentUrl(): string {
  return plansUrl();
}

function stripeSecretKey(): string | undefined {
  return envValue("IMAP_PLUGIN_STRIPE_SECRET_KEY", "STRIPE_SECRET_KEY");
}

function stripePriceId(feature: PaidFeature): string | undefined {
  if (feature === "mail_actions") {
    return envValue("IMAP_PLUGIN_STRIPE_MAIL_ACTIONS_PRICE_ID", "IMAP_PLUGIN_STRIPE_PRICE_ID") || DEFAULT_MAIL_ACTIONS_PRICE_ID;
  }

  return undefined;
}

function stripePriceIds(feature: PaidFeature): string[] {
  const configured = envValue("IMAP_PLUGIN_STRIPE_MAIL_ACTIONS_PRICE_IDS");
  if (configured && feature === "mail_actions") {
    return configured.split(",").map((value) => value.trim()).filter(Boolean);
  }

  const legacy = stripePriceId(feature);
  if (feature === "mail_actions") {
    return [...new Set([...(legacy ? [legacy] : []), ...DEFAULT_MAIL_ACTIONS_PRICE_IDS])];
  }

  return legacy ? [legacy] : [];
}

async function stripeGet<T>(secretKey: string, path: string, params?: URLSearchParams): Promise<T> {
  const url = new URL(`${STRIPE_API_BASE_URL}${path}`);
  if (params) {
    url.search = params.toString();
  }

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${secretKey}`
    }
  });
  const body = (await response.json()) as { error?: { message?: string } };
  if (!response.ok) {
    throw new Error(body.error?.message || `Stripe request failed with status ${response.status}.`);
  }

  return body as T;
}

function customerId(value: { customer?: string | { id?: string } }): string | undefined {
  return typeof value.customer === "string" ? value.customer : value.customer?.id;
}

function validUntil(subscription: StripeSubscription): string | undefined {
  return subscription.current_period_end ? new Date(subscription.current_period_end * 1000).toISOString() : undefined;
}

function matchesAnyFeaturePrice(subscription: StripeSubscription, priceIds: string[]): boolean {
  if (priceIds.length === 0) {
    return true;
  }

  return subscription.items?.data?.some((item) => item.price?.id && priceIds.includes(item.price.id)) ?? false;
}

function stripeSubscriptionFromObject(value: unknown): StripeSubscription | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as Partial<StripeSubscription> & { object?: string };
  if (candidate.object !== "subscription" || !candidate.id || typeof candidate.id !== "string") {
    return undefined;
  }

  return candidate as StripeSubscription;
}

function stripeCheckoutSessionFromObject(value: unknown): StripeCheckoutSession | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as Partial<StripeCheckoutSession> & { object?: string };
  if (candidate.object !== "checkout.session" || !candidate.id || typeof candidate.id !== "string") {
    return undefined;
  }

  return candidate as StripeCheckoutSession;
}

function objectId(value: string | { id?: string } | undefined): string | undefined {
  return typeof value === "string" ? value : value?.id;
}

function checkoutInstallationId(session: StripeCheckoutSession): string | undefined {
  const field = session.custom_fields?.find((candidate) => candidate.key?.toLowerCase() === "installationid");
  return field?.text?.value?.trim();
}

function envSubscriptionStatus(feature: PaidFeature): SubscriptionStatus {
  const status = envValue("IMAP_PLUGIN_SUBSCRIPTION_STATUS")?.toLowerCase() || "none";

  return {
    feature,
    live: LIVE_SUBSCRIPTION_STATUSES.has(status),
    status,
    plansUrl: plansUrl(),
    paymentUrl: plansUrl(),
    provider: "env"
  };
}

export async function subscriptionStatus(feature: PaidFeature): Promise<SubscriptionStatus> {
  const installation = await installationStatus(feature);
  if (installation.live || envValue("IMAP_PLUGIN_ENTITLEMENT_PROVIDER") === "installation") {
    return installation;
  }

  return envSubscriptionStatus(feature);
}

export async function activateSubscription(feature: PaidFeature, subscriptionId: string): Promise<ActivationResult> {
  const installation = await readOrCreateInstallation();
  if (!hasSqlConnectionString()) {
    return {
      ok: false,
      code: "entitlement_db_not_configured",
      message: "Subscription activation requires the entitlement database.",
      installation
    };
  }

  const secretKey = stripeSecretKey();
  if (!secretKey) {
    return {
      ok: false,
      code: "stripe_not_configured",
      message: "Subscription activation requires Stripe API access on the MCP server.",
      installation
    };
  }

  try {
    const stripeSubscription = await stripeGet<StripeSubscription>(
      secretKey,
      `/subscriptions/${encodeURIComponent(subscriptionId)}`,
      new URLSearchParams([["expand[]", "items.data.price"]])
    );
    const status = stripeSubscription.status.toLowerCase();
    const priceIds = stripePriceIds(feature);
    const stripe = {
      subscriptionId: stripeSubscription.id,
      customerId: customerId(stripeSubscription),
      status,
      validUntil: validUntil(stripeSubscription)
    };

    if (!LIVE_SUBSCRIPTION_STATUSES.has(status)) {
      return {
        ok: false,
        code: "subscription_not_live",
        message: `Stripe subscription ${stripeSubscription.id} is ${status}, not active.`,
        installation,
        stripe
      };
    }

    if (!matchesAnyFeaturePrice(stripeSubscription, priceIds)) {
      return {
        ok: false,
        code: "subscription_price_mismatch",
        message: "This Stripe subscription does not include a Mail Actions price.",
        installation,
        stripe
      };
    }

    await upsertInstallationEntitlement({
      installationId: installation.installationId,
      feature,
      status,
      customerId: stripe.customerId,
      subscriptionId: stripe.subscriptionId,
      validUntil: stripe.validUntil
    });

    return {
      ok: true,
      message: "Mail Actions subscription activated for this installation.",
      installation,
      subscription: await subscriptionStatus(feature),
      stripe
    };
  } catch (error) {
    return {
      ok: false,
      code: "stripe_error",
      message: error instanceof Error ? error.message : "Unknown Stripe error.",
      installation
    };
  }
}

export async function syncStripeSubscriptionEntitlement(
  feature: PaidFeature,
  subscription: StripeSubscription
): Promise<EntitlementSyncResult> {
  if (!hasSqlConnectionString()) {
    return {
      ok: false,
      action: "ignored",
      reason: "entitlement_db_not_configured"
    };
  }

  const existing = await readInstallationEntitlementBySubscription(subscription.id, feature);
  if (!existing) {
    return {
      ok: true,
      action: "ignored",
      reason: "subscription_not_activated"
    };
  }

  const next = await upsertInstallationEntitlement({
    installationId: existing.installationId,
    feature,
    status: subscription.status.toLowerCase(),
    customerId: customerId(subscription) ?? existing.customerId,
    subscriptionId: subscription.id,
    validUntil: validUntil(subscription)
  });

  return {
    ok: true,
    action: "updated",
    entitlement: next
  };
}

async function syncStripeCheckoutEntitlement(session: StripeCheckoutSession): Promise<EntitlementSyncResult> {
  if (!hasSqlConnectionString()) {
    return {
      ok: false,
      action: "ignored",
      reason: "entitlement_db_not_configured"
    };
  }

  const installationId = checkoutInstallationId(session);
  if (!installationId) {
    return {
      ok: true,
      action: "ignored",
      reason: "checkout_installation_id_missing"
    };
  }

  if (session.status && session.status !== "complete") {
    return {
      ok: true,
      action: "ignored",
      reason: `checkout_not_complete:${session.status}`
    };
  }

  if (session.payment_status && !["paid", "no_payment_required"].includes(session.payment_status)) {
    return {
      ok: true,
      action: "ignored",
      reason: `checkout_not_paid:${session.payment_status}`
    };
  }

  const plan = session.metadata?.plan;
  const subscriptionId = objectId(session.subscription);
  const paymentIntentId = objectId(session.payment_intent);

  if (subscriptionId) {
    const next = await upsertInstallationEntitlement({
      installationId,
      feature: "mail_actions",
      status: "active",
      customerId: customerId(session),
      subscriptionId
    });

    return {
      ok: true,
      action: "updated",
      entitlement: next
    };
  }

  if (plan === "founder_lifetime" && paymentIntentId) {
    const next = await upsertInstallationEntitlement({
      installationId,
      feature: "mail_actions",
      status: "lifetime",
      customerId: customerId(session),
      subscriptionId: paymentIntentId
    });

    return {
      ok: true,
      action: "updated",
      entitlement: next
    };
  }

  return {
    ok: true,
    action: "ignored",
    reason: `checkout_without_supported_payment:${session.id}`
  };
}

export async function syncStripeSubscriptionById(feature: PaidFeature, subscriptionId: string): Promise<EntitlementSyncResult> {
  const secretKey = stripeSecretKey();
  if (!secretKey) {
    return {
      ok: false,
      action: "ignored",
      reason: "stripe_not_configured"
    };
  }

  const subscription = await stripeGet<StripeSubscription>(
    secretKey,
    `/subscriptions/${encodeURIComponent(subscriptionId)}`,
    new URLSearchParams([["expand[]", "items.data.price"]])
  );
  return syncStripeSubscriptionEntitlement(feature, subscription);
}

export async function handleStripeBillingEvent(event: StripeWebhookEvent): Promise<EntitlementSyncResult> {
  const object = event.data?.object;
  const checkoutSession = stripeCheckoutSessionFromObject(object);
  if (checkoutSession) {
    return syncStripeCheckoutEntitlement(checkoutSession);
  }

  const subscription = stripeSubscriptionFromObject(object);
  if (subscription) {
    return syncStripeSubscriptionEntitlement("mail_actions", subscription);
  }

  if (object && typeof object === "object" && "subscription" in object) {
    const subscriptionId = (object as { subscription?: unknown }).subscription;
    if (typeof subscriptionId === "string" && subscriptionId.startsWith("sub_")) {
      return syncStripeSubscriptionById("mail_actions", subscriptionId);
    }
  }

  return {
    ok: true,
    action: "ignored",
    reason: `unsupported_event:${event.type}`
  };
}

export async function subscriptionRequired(feature: PaidFeature, action: string): Promise<SubscriptionRequired> {
  const installation = await readOrCreateInstallation();
  return {
    ok: false,
    code: "subscription_required",
    requiresSubscription: true,
    feature,
    action,
    message: `${action} requires Mail Actions. Open the plans page, choose a plan, and paste this installation ID into Stripe Checkout so this installation can be activated automatically.`,
    installation,
    plansUrl: plansUrl(),
    paymentUrl: plansUrl()
  };
}

export async function requireSubscription(feature: PaidFeature, action: string): Promise<SubscriptionRequired | undefined> {
  return (await subscriptionStatus(feature)).live ? undefined : subscriptionRequired(feature, action);
}
