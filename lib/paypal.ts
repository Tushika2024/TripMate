// Server-only PayPal REST helper: Orders v2 + Payments v2 (authorizations).
// Follows PayPal AI-Toolkit best practices: cached OAuth token, PayPal-Request-Id on
// every POST, debug_id logged on errors, server-side order creation.
import { randomUUID } from "crypto";
import { centsToValue } from "./money";

const API_BASE = process.env.PAYPAL_API_BASE || "https://api-m.sandbox.paypal.com";

export class PayPalError extends Error {
  constructor(
    message: string,
    public status: number,
    public issue: string | null,
    public debugId: string | null,
  ) {
    super(message);
  }
}

// ---------- OAuth token (cached until shortly before expiry) ----------

let cachedToken: { value: string; expiresAt: number } | null = null;

export async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.value;

  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) {
    throw new PayPalError("PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET missing in .env", 500, null, null);
  }

  const res = await fetch(`${API_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new PayPalError(
      `PayPal auth failed (${res.status}): ${data.error_description || data.error || "unknown"}. Check sandbox client ID/secret.`,
      res.status,
      data.error ?? null,
      res.headers.get("paypal-debug-id"),
    );
  }
  cachedToken = { value: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return cachedToken.value;
}

// ---------- Low-level request ----------

export async function paypalRequest<T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  requestId?: string,
): Promise<T> {
  const token = await getAccessToken();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
  if (method === "POST") headers["PayPal-Request-Id"] = requestId ?? randomUUID();

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? (method === "POST" ? "{}" : undefined) : JSON.stringify(body),
    cache: "no-store",
  });
  const text = await res.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { message: text.slice(0, 200) };
  }
  if (!res.ok) {
    const debugId = data.debug_id ?? res.headers.get("paypal-debug-id");
    const issue = data.details?.[0]?.issue ?? data.name ?? null;
    console.error(`[paypal] ${method} ${path} -> ${res.status} issue=${issue} debug_id=${debugId}`);
    throw new PayPalError(
      `${data.details?.[0]?.description || data.message || "PayPal request failed"}${issue ? ` (${issue})` : ""}`,
      res.status,
      issue,
      debugId,
    );
  }
  return data as T;
}

// ---------- Types ----------

interface PayPalLink { href: string; rel: string }
interface PayPalAuthorization { id: string; status: string; expiration_time?: string }
interface PayPalCapture { id: string; status: string }
interface PayPalOrder {
  id: string;
  status: string;
  links?: PayPalLink[];
  purchase_units?: Array<{
    payee?: { email_address?: string; merchant_id?: string };
    payments?: { authorizations?: PayPalAuthorization[]; captures?: PayPalCapture[] };
  }>;
}

function summarizeOrder(order: PayPalOrder) {
  const pay = order.purchase_units?.[0]?.payments;
  const auth = pay?.authorizations?.[0];
  const cap = pay?.captures?.[0];
  return {
    id: order.id,
    status: order.status,
    authorizationId: auth?.id ?? null,
    authorizationStatus: auth?.status ?? null,
    expiresAt: auth?.expiration_time ?? null,
    captureId: cap?.id ?? null,
    captureStatus: cap?.status ?? null,
  };
}

// ---------- Orders ----------

export interface CreateOrderInput {
  intent: "CAPTURE" | "AUTHORIZE";
  amountCents: number;
  currency: string;
  referenceId: string;
  description: string;
  returnUrl: string;
  cancelUrl: string;
  softDescriptor?: string;
}

/** Creates an order and returns the URL the payer must open to approve it. */
export async function createOrder(input: CreateOrderInput) {
  const order = await paypalRequest<PayPalOrder>("POST", "/v2/checkout/orders", {
    intent: input.intent,
    purchase_units: [
      {
        reference_id: input.referenceId.slice(0, 256),
        description: input.description.slice(0, 127),
        // Shown on the payer's statement; PayPal prefixes it with the merchant's name.
        soft_descriptor: (input.softDescriptor ?? "TRIPMATE").replace(/[^A-Za-z0-9 ]/g, "").slice(0, 22) || "TRIPMATE",
        amount: { currency_code: input.currency, value: centsToValue(input.amountCents) },
      },
    ],
    payment_source: {
      paypal: {
        experience_context: {
          brand_name: "TripMate AI",
          // AUTHORIZE only places a hold, so the button says "Continue", not "Pay Now".
          user_action: input.intent === "AUTHORIZE" ? "CONTINUE" : "PAY_NOW",
          shipping_preference: "NO_SHIPPING",
          return_url: input.returnUrl,
          cancel_url: input.cancelUrl,
        },
      },
    },
  });

  const approveUrl =
    order.links?.find((l) => l.rel === "payer-action")?.href ??
    order.links?.find((l) => l.rel === "approve")?.href ??
    null;
  // PayPal tells us which merchant account will receive the money (the business account
  // that owns this REST app). We record it and verify it again before capturing.
  const payee = order.purchase_units?.[0]?.payee;
  return {
    id: order.id,
    status: order.status,
    approveUrl,
    payee: payee ? { merchantId: payee.merchant_id ?? null, email: payee.email_address ?? null } : null,
  };
}

/** Payee (receiving merchant) of an existing order, straight from PayPal. */
export async function getOrderPayee(orderId: string) {
  const order = await paypalRequest<PayPalOrder>("GET", `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
  const p = order.purchase_units?.[0]?.payee;
  return p ? { merchantId: p.merchant_id ?? null, email: p.email_address ?? null } : null;
}

export async function getOrder(orderId: string) {
  const order = await paypalRequest<PayPalOrder>("GET", `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
  return summarizeOrder(order);
}

/** After buyer approval: place the hold. Idempotent per order. */
export async function authorizeOrder(orderId: string) {
  try {
    const order = await paypalRequest<PayPalOrder>(
      "POST",
      `/v2/checkout/orders/${encodeURIComponent(orderId)}/authorize`,
      undefined,
      `authorize-${orderId}`,
    );
    return summarizeOrder(order);
  } catch (err) {
    if (err instanceof PayPalError && err.issue === "ORDER_ALREADY_AUTHORIZED") return getOrder(orderId);
    throw err;
  }
}

// ---------- Authorizations (Payments v2) ----------

export async function getAuthorization(authorizationId: string) {
  const a = await paypalRequest<PayPalAuthorization>(
    "GET",
    `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}`,
  );
  return { id: a.id, status: a.status, expiresAt: a.expiration_time ?? null };
}

/** Collect the held funds. Idempotent per authorization. */
export async function captureAuthorization(authorizationId: string) {
  try {
    const cap = await paypalRequest<PayPalCapture>(
      "POST",
      `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/capture`,
      { final_capture: true },
      `capture-${authorizationId}`,
    );
    return { captureId: cap.id, status: cap.status };
  } catch (err) {
    if (err instanceof PayPalError && err.issue === "AUTHORIZATION_ALREADY_CAPTURED") {
      return { captureId: null, status: "COMPLETED" };
    }
    throw err;
  }
}

/** Release the hold. Idempotent per authorization. */
export async function voidAuthorization(authorizationId: string) {
  try {
    await paypalRequest<unknown>(
      "POST",
      `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/void`,
      undefined,
      `void-${authorizationId}`,
    );
    return { status: "VOIDED" };
  } catch (err) {
    if (err instanceof PayPalError) {
      const a = await getAuthorization(authorizationId).catch(() => null);
      if (a?.status === "VOIDED") return { status: "VOIDED" };
    }
    throw err;
  }
}

/** Public base URL of this app (for PayPal return/cancel redirects). */
export function getAppUrl(req: Request): string {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  const h = req.headers;
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  return host ? `${proto}://${host}` : new URL(req.url).origin;
}
