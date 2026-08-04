import { readOrCreateInstallation } from "../config/installation.js";
import { hasSqlConnectionString } from "../config/sql.js";
import { readInstallationEntitlement } from "./installation-entitlements.js";

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

const DEFAULT_PLANS_URL = "https://paulstsmith.github.io/imap-plugin/#plans";
const LIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing"]);

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

export async function subscriptionRequired(feature: PaidFeature, action: string): Promise<SubscriptionRequired> {
  const installation = await readOrCreateInstallation();
  return {
    ok: false,
    code: "subscription_required",
    requiresSubscription: true,
    feature,
    action,
    message: `${action} requires a Mail Actions subscription. Open the plans page, choose a plan, then register this installation ID after checkout.`,
    installation,
    plansUrl: plansUrl(),
    paymentUrl: plansUrl()
  };
}

export async function requireSubscription(feature: PaidFeature, action: string): Promise<SubscriptionRequired | undefined> {
  return (await subscriptionStatus(feature)).live ? undefined : subscriptionRequired(feature, action);
}
