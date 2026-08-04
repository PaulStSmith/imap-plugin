import { createHmac, timingSafeEqual } from "node:crypto";
import { IncomingMessage } from "node:http";
import { handleStripeBillingEvent, StripeWebhookEvent } from "./subscription.js";

export interface StripeWebhookResult {
  ok: boolean;
  eventId?: string;
  eventType?: string;
  result?: Awaited<ReturnType<typeof handleStripeBillingEvent>>;
  error?: string;
}

const DEFAULT_TOLERANCE_SECONDS = 300;

function webhookSecret(): string | undefined {
  return process.env.IMAP_PLUGIN_STRIPE_WEBHOOK_SECRET?.trim() || process.env.STRIPE_WEBHOOK_SECRET?.trim();
}

function parseSignatureHeader(header: string): { timestamp?: string; signatures: string[] } {
  const result: { timestamp?: string; signatures: string[] } = { signatures: [] };
  for (const part of header.split(",")) {
    const [key, value] = part.split("=", 2);
    if (key === "t") {
      result.timestamp = value;
    } else if (key === "v1" && value) {
      result.signatures.push(value);
    }
  }

  return result;
}

function secureCompareHex(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

function verifyStripeSignature(rawBody: Buffer, signatureHeader: string, secret: string): void {
  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed.timestamp || parsed.signatures.length === 0) {
    throw new Error("Stripe signature header is missing timestamp or v1 signature.");
  }

  const timestamp = Number(parsed.timestamp);
  if (!Number.isFinite(timestamp)) {
    throw new Error("Stripe signature timestamp is invalid.");
  }

  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
  if (ageSeconds > DEFAULT_TOLERANCE_SECONDS) {
    throw new Error("Stripe signature timestamp is outside the allowed tolerance.");
  }

  const signedPayload = Buffer.concat([
    Buffer.from(`${parsed.timestamp}.`, "utf8"),
    rawBody
  ]);
  const expected = createHmac("sha256", secret).update(signedPayload).digest("hex");
  if (!parsed.signatures.some((signature) => secureCompareHex(signature, expected))) {
    throw new Error("Stripe webhook signature verification failed.");
  }
}

export async function handleStripeWebhookRequest(request: IncomingMessage & { body?: unknown }): Promise<StripeWebhookResult> {
  const secret = webhookSecret();
  if (!secret) {
    return {
      ok: false,
      error: "IMAP_PLUGIN_STRIPE_WEBHOOK_SECRET is required."
    };
  }

  const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.from(JSON.stringify(request.body ?? {}), "utf8");
  const signature = request.headers["stripe-signature"];
  if (typeof signature !== "string") {
    return {
      ok: false,
      error: "Stripe-Signature header is required."
    };
  }

  try {
    verifyStripeSignature(rawBody, signature, secret);
    const event = JSON.parse(rawBody.toString("utf8")) as StripeWebhookEvent;
    const result = await handleStripeBillingEvent(event);
    return {
      ok: result.ok,
      eventId: event.id,
      eventType: event.type,
      result
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Stripe webhook handling failed."
    };
  }
}
