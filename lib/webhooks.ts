// PayPal webhooks: signature-verified, idempotent confirmations of payment events.
// The redirect path already authorizes; webhooks confirm the ledger from PayPal's side
// and catch members who approved but closed the tab before returning.
import { paypalRequest } from "./paypal";
import { addSystemMessage, addTimeline, memberName, nowIso, updateStore, type Commitment, type Trip } from "./store";
import { authorizeIfNeeded } from "./commit";
import { recomputeStatus } from "./trips";
import { formatMoney } from "./money";

export interface WebhookEvent {
  id: string;
  event_type: string;
  resource: any;
}

export async function verifySignature(headers: Headers, event: unknown): Promise<boolean> {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) return false;
  const r = await paypalRequest<{ verification_status: string }>("POST", "/v1/notifications/verify-webhook-signature", {
    auth_algo: headers.get("paypal-auth-algo"),
    cert_url: headers.get("paypal-cert-url"),
    transmission_id: headers.get("paypal-transmission-id"),
    transmission_sig: headers.get("paypal-transmission-sig"),
    transmission_time: headers.get("paypal-transmission-time"),
    webhook_id: webhookId,
    webhook_event: event,
  });
  return r.verification_status === "SUCCESS";
}

function findBy(trips: Trip[], pred: (c: Commitment) => boolean) {
  for (const trip of trips) {
    const c = trip.commitments.find(pred);
    if (c) return { trip, c };
  }
  return null;
}

export async function handleEvent(ev: WebhookEvent): Promise<string> {
  // CHECKOUT.ORDER.APPROVED: buyer approved but may never have returned -> authorize now.
  if (ev.event_type === "CHECKOUT.ORDER.APPROVED") {
    const orderId: string = ev.resource?.id;
    if (orderId) {
      const r = await authorizeIfNeeded(orderId);
      if (r.found) {
        await updateStore((s) => {
          const t = s.trips.find((x) => x.id === r.trip.id);
          if (t) addTimeline(t, "webhook", `PayPal webhook ${ev.event_type} for ${memberName(t, r.c.memberId)}`);
        });
        return "authorized";
      }
    }
    return "ignored";
  }

  return updateStore((s) => {
    if (s.processedWebhookIds.includes(ev.id)) return "duplicate";
    s.processedWebhookIds.push(ev.id);
    if (s.processedWebhookIds.length > 500) s.processedWebhookIds.splice(0, 100);

    const res = ev.resource ?? {};
    const related = res.supplementary_data?.related_ids ?? {};
    let hit: { trip: Trip; c: Commitment } | null = null;

    switch (ev.event_type) {
      case "PAYMENT.AUTHORIZATION.CREATED":
        hit = findBy(s.trips, (c) => c.authorizationId === res.id || c.orderId === related.order_id);
        if (hit && hit.c.status === "CREATED") {
          hit.c.status = "AUTHORIZED";
          hit.c.authorizationId = res.id;
          hit.c.expiresAt = res.expiration_time ?? hit.c.expiresAt;
          addSystemMessage(hit.trip, `🔒 ${memberName(hit.trip, hit.c.memberId)} committed ${formatMoney(hit.c.cents, hit.c.currency)}.`);
        }
        break;
      case "PAYMENT.AUTHORIZATION.VOIDED":
        hit = findBy(s.trips, (c) => c.authorizationId === res.id);
        if (hit && hit.c.status === "AUTHORIZED") hit.c.status = "VOIDED";
        break;
      case "PAYMENT.CAPTURE.COMPLETED":
        hit = findBy(s.trips, (c) => c.authorizationId === related.authorization_id || c.captureId === res.id);
        if (hit && hit.c.status !== "CAPTURED") {
          hit.c.status = "CAPTURED";
          hit.c.captureId = res.id;
        }
        break;
      case "PAYMENT.CAPTURE.DENIED":
      case "PAYMENT.CAPTURE.DECLINED":
        hit = findBy(s.trips, (c) => c.authorizationId === related.authorization_id || c.captureId === res.id);
        if (hit) {
          hit.c.status = "CAPTURE_FAILED";
          hit.c.lastError = `PayPal reported ${ev.event_type}`;
          hit.trip.status = "AT_RISK";
          addSystemMessage(hit.trip, `⚠️ PayPal reported a failed capture for ${memberName(hit.trip, hit.c.memberId)}. Ask the agent for options.`);
        }
        break;
    }
    if (!hit) return "no_match";
    hit.c.updatedAt = nowIso();
    addTimeline(hit.trip, "webhook", `PayPal webhook ${ev.event_type} verified (${memberName(hit.trip, hit.c.memberId)})`);
    recomputeStatus(hit.trip);
    return "applied";
  });
}
