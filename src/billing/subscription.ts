import { licenseStatus } from "./license.js";

export type PaidFeature = "mail_actions";

export interface SubscriptionStatus {
  feature: PaidFeature;
  live: boolean;
  status: string;
  paymentUrl: string;
  provider: "license" | "stripe" | "env";
  license?: {
    installed: boolean;
    state: string;
    licenseId?: string;
    validUntil?: string;
    graceUntil?: string;
    path: string;
  };
  stripe?: {
    configured: boolean;
    customerId?: string;
    subscriptionId?: string;
    priceId?: string;
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
  paymentUrl: string;
}

const DEFAULT_PAYMENT_URL = "https://paulstsmith.github.io/imap-plugin/#plans";
const LIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing"]);
const STRIPE_API_BASE_URL = "https://api.stripe.com/v1";

interface StripeSubscriptionItem {
  price?: {
    id?: string;
  };
}

interface StripeSubscription {
  id: string;
  status: string;
  items?: {
    data?: StripeSubscriptionItem[];
  };
}

interface StripeListResponse<T> {
  data?: T[];
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

function featureEnvKey(feature: PaidFeature): string {
  return feature.toUpperCase();
}

function stripeSecretKey(): string | undefined {
  return envValue("IMAP_PLUGIN_STRIPE_SECRET_KEY", "STRIPE_SECRET_KEY");
}

function stripeCustomerId(): string | undefined {
  return envValue("IMAP_PLUGIN_STRIPE_CUSTOMER_ID", "STRIPE_CUSTOMER_ID");
}

function stripeSubscriptionId(feature: PaidFeature): string | undefined {
  const key = featureEnvKey(feature);
  return envValue(`IMAP_PLUGIN_STRIPE_${key}_SUBSCRIPTION_ID`, "IMAP_PLUGIN_STRIPE_SUBSCRIPTION_ID", "STRIPE_SUBSCRIPTION_ID");
}

function stripePriceId(feature: PaidFeature): string | undefined {
  const key = featureEnvKey(feature);
  return envValue(`IMAP_PLUGIN_STRIPE_${key}_PRICE_ID`, "IMAP_PLUGIN_STRIPE_PRICE_ID", "STRIPE_PRICE_ID");
}

function stripeConfig(feature: PaidFeature) {
  return {
    secretKey: stripeSecretKey(),
    customerId: stripeCustomerId(),
    subscriptionId: stripeSubscriptionId(feature),
    priceId: stripePriceId(feature)
  };
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

function matchesFeature(subscription: StripeSubscription, priceId?: string): boolean {
  if (!priceId) {
    return true;
  }

  return subscription.items?.data?.some((item) => item.price?.id === priceId) ?? false;
}

export function paymentUrl(): string {
  return envValue("IMAP_PLUGIN_STRIPE_PAYMENT_URL", "IMAP_PLUGIN_PAYMENT_URL", "STRIPE_PAYMENT_URL") || DEFAULT_PAYMENT_URL;
}

function envSubscriptionStatus(feature: PaidFeature): SubscriptionStatus {
  const status = envValue("IMAP_PLUGIN_SUBSCRIPTION_STATUS")?.toLowerCase() || "none";

  return {
    feature,
    live: LIVE_SUBSCRIPTION_STATUSES.has(status),
    status,
    paymentUrl: paymentUrl(),
    provider: "env"
  };
}

export async function subscriptionStatus(feature: PaidFeature): Promise<SubscriptionStatus> {
  const localLicense = await licenseStatus();
  if (localLicense.installed) {
    return {
      feature,
      live: localLicense.live,
      status: localLicense.state,
      paymentUrl: paymentUrl(),
      provider: "license",
      license: {
        installed: localLicense.installed,
        state: localLicense.state,
        licenseId: localLicense.license?.licenseId,
        validUntil: localLicense.license?.validUntil,
        graceUntil: localLicense.license?.graceUntil,
        path: localLicense.path
      },
      error: localLicense.reason
    };
  }

  const config = stripeConfig(feature);

  if (!config.secretKey) {
    return envSubscriptionStatus(feature);
  }

  const stripeMetadata = {
    configured: Boolean(config.customerId || config.subscriptionId),
    customerId: config.customerId,
    subscriptionId: config.subscriptionId,
    priceId: config.priceId
  };

  try {
    if (config.subscriptionId) {
      const subscription = await stripeGet<StripeSubscription>(
        config.secretKey,
        `/subscriptions/${encodeURIComponent(config.subscriptionId)}`,
        new URLSearchParams([["expand[]", "items.data.price"]])
      );
      const status = matchesFeature(subscription, config.priceId) ? subscription.status.toLowerCase() : "price_mismatch";

      return {
        feature,
        live: LIVE_SUBSCRIPTION_STATUSES.has(status),
        status,
        paymentUrl: paymentUrl(),
        provider: "stripe",
        stripe: stripeMetadata
      };
    }

    if (config.customerId) {
      const subscriptions = await stripeGet<StripeListResponse<StripeSubscription>>(
        config.secretKey,
        "/subscriptions",
        new URLSearchParams([
          ["customer", config.customerId],
          ["status", "all"],
          ["limit", "100"],
          ["expand[]", "data.items.data.price"]
        ])
      );
      const matchingSubscription = subscriptions.data?.find((subscription) => matchesFeature(subscription, config.priceId));
      const status = matchingSubscription?.status.toLowerCase() || "none";

      return {
        feature,
        live: LIVE_SUBSCRIPTION_STATUSES.has(status),
        status,
        paymentUrl: paymentUrl(),
        provider: "stripe",
        stripe: {
          ...stripeMetadata,
          subscriptionId: matchingSubscription?.id || config.subscriptionId
        }
      };
    }

    return {
      feature,
      live: false,
      status: "stripe_not_configured",
      paymentUrl: paymentUrl(),
      provider: "stripe",
      stripe: stripeMetadata
    };
  } catch (error) {
    return {
      feature,
      live: false,
      status: "stripe_error",
      paymentUrl: paymentUrl(),
      provider: "stripe",
      stripe: stripeMetadata,
      error: error instanceof Error ? error.message : "Unknown Stripe error."
    };
  }
}

export function subscriptionRequired(feature: PaidFeature, action: string): SubscriptionRequired {
  return {
    ok: false,
    code: "subscription_required",
    requiresSubscription: true,
    feature,
    action,
    message: `${action} requires an active IMAP Mailboxes subscription. Use the payment link to upgrade, then try again.`,
    paymentUrl: paymentUrl()
  };
}

export async function requireSubscription(feature: PaidFeature, action: string): Promise<SubscriptionRequired | undefined> {
  return (await subscriptionStatus(feature)).live ? undefined : subscriptionRequired(feature, action);
}
