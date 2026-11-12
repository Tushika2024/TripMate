// GroupCommit: AUTHORIZE each share -> CAPTURE all when the group is ready, or VOID all.
// Every PayPal side effect inside updateStore() catches its own errors and records
// them, so a failure never discards state that already happened at PayPal.
import {
  addSystemMessage,
  addTimeline,
  HttpError,
  memberName,
  nowIso,
  updateStore,
  type Commitment,
  type Store,
  type Trip,
} from "./store";
import {
  authorizeOrder,
  captureAuthorization,
  createOrder,
  getOrder,
  getOrderPayee,
  PayPalError,
  voidAuthorization,
} from "./paypal";
import { allApproved, getTripOr404, recomputeStatus, requireMember, requireOrganizer } from "./trips";
import { formatMoney } from "./money";

function errText(e: unknown) {
  if (e instanceof PayPalError) return `${e.message}${e.debugId ? ` [debug_id ${e.debugId}]` : ""}`;
  return e instanceof Error ? e.message : String(e);
}

export function findCommitment(store: Store, orderId: string): { trip: Trip; c: Commitment } | null {
  for (const trip of store.trips) {
    const c = trip.commitments.find((x) => x.orderId === orderId);
    if (c) return { trip, c };
  }
  return null;
}

/** Create one AUTHORIZE order and attach it to the trip. */
export async function createCommitment(
  trip: Trip,
  opts: {
    memberId: string;
    cents: number;
    kind: Commitment["kind"];
    onBehalfOf?: string | null;
    createdBy?: Commitment["createdBy"];
    baseUrl: string;
  },
): Promise<Commitment> {
  const who = memberName(trip, opts.memberId);
  const label =
    opts.kind === "COVER"
      ? `cover for ${memberName(trip, opts.onBehalfOf ?? "")}`
      : opts.kind === "TOPUP"
        ? "top-up"
        : "share";
  const order = await createOrder({
    intent: "AUTHORIZE",
    amountCents: opts.cents,
    currency: trip.currency,
    referenceId: `${trip.id}:${opts.memberId}:${opts.kind.toLowerCase()}:v${trip.plan.version}`,
    description: `${trip.merchant} - ${who}'s ${label} (${trip.name})`,
    returnUrl: `${opts.baseUrl}/api/paypal/return`,
    cancelUrl: `${opts.baseUrl}/api/paypal/cancel`,
    softDescriptor: trip.merchant,
  });
  let payee = order.payee;
  if (!payee?.merchantId) payee = await getOrderPayee(order.id).catch(() => payee);
  const c: Commitment = {
    orderId: order.id,
    authorizationId: null,
    captureId: null,
    memberId: opts.memberId,
    onBehalfOf: opts.onBehalfOf ?? null,
    kind: opts.kind,
    cents: opts.cents,
    currency: trip.currency,
    status: "CREATED",
    approveUrl: order.approveUrl,
    expiresAt: null,
    createdBy: opts.createdBy ?? "system",
    payee,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    lastError: null,
  };
  trip.commitments.push(c);
  addTimeline(trip, "paypal", `Order ${order.id} created (AUTHORIZE ${formatMoney(c.cents, c.currency)} for ${who})`);
  // Lock the receiving merchant on the first order; flag any order that would pay someone else.
  if (payee?.merchantId) {
    if (!trip.payee?.merchantId) {
      trip.payee = payee;
      addTimeline(trip, "paypal", `PayPal confirms money goes to merchant ${payee.merchantId}${payee.email ? ` (${payee.email})` : ""}`);
    } else if (trip.payee.merchantId !== payee.merchantId) {
      c.lastError = `Payee mismatch: this order pays ${payee.merchantId}, the trip pays ${trip.payee.merchantId}. It will not be captured.`;
      addTimeline(trip, "paypal", `⚠️ ${c.lastError}`);
    }
  }
  return c;
}

/** Organizer starts GroupCommit: lock plan, create one AUTHORIZE order per share. */
export async function startCommit(tripId: string, userId: string, baseUrl: string) {
  return updateStore(async (s) => {
    const trip = getTripOr404(s, tripId);
    requireOrganizer(trip, userId);
    if (trip.plan.locked) throw new HttpError(409, "GroupCommit already started");
    if (!allApproved(trip)) throw new HttpError(409, "Every member must approve the current plan first");

    const created: Commitment[] = [];
    for (const share of trip.plan.shares) {
      if (share.cents <= 0) continue;
      try {
        created.push(await createCommitment(trip, { memberId: share.memberId, cents: share.cents, kind: "SHARE", baseUrl }));
      } catch (e) {
        // Roll back locally (unapproved orders simply expire at PayPal).
        trip.commitments = trip.commitments.filter((c) => !created.includes(c));
        throw new HttpError(502, `Could not create PayPal order: ${errText(e)}`);
      }
    }
    trip.plan.locked = true;
    trip.status = "COLLECTING";
    addSystemMessage(trip, "🔒 GroupCommit started. Everyone, open your PayPal link and commit your share. Nothing is charged until the group is ready.");
    addTimeline(trip, "user", `${memberName(trip, userId)} started GroupCommit (plan v${trip.plan.version} locked)`);
    return trip;
  });
}

/**
 * Called from the PayPal return redirect (and later from webhooks).
 * Idempotent: authorizes only if not authorized yet.
 */
export type AuthorizeResult =
  | { found: false }
  | { found: true; ok: boolean; trip: Trip; c: Commitment; already: boolean };

export async function authorizeIfNeeded(orderId: string): Promise<AuthorizeResult> {
  return updateStore<AuthorizeResult>(async (s) => {
    const found = findCommitment(s, orderId);
    if (!found) return { found: false };
    const { trip, c } = found;
    if (c.status !== "CREATED") return { found: true, ok: c.status !== "VOIDED" && c.status !== "CANCELLED", trip, c, already: true };

    try {
      const r = await authorizeOrder(orderId);
      if (r.authorizationId && (r.authorizationStatus === "CREATED" || r.authorizationStatus === "PENDING")) {
        c.status = "AUTHORIZED";
        c.authorizationId = r.authorizationId;
        c.expiresAt = r.expiresAt;
        c.lastError = null;
        c.updatedAt = nowIso();
        addSystemMessage(trip, `🔒 ${memberName(trip, c.memberId)} committed ${formatMoney(c.cents, c.currency)}${c.onBehalfOf ? ` (covering ${memberName(trip, c.onBehalfOf)})` : ""}.`);
        addTimeline(trip, "paypal", `Authorization ${r.authorizationId} placed for ${memberName(trip, c.memberId)} (hold until ${r.expiresAt ?? "?"})`);
      } else {
        c.lastError = `Unexpected authorization status: ${r.authorizationStatus ?? r.status}`;
      }
    } catch (e) {
      c.lastError = errText(e);
      addTimeline(trip, "paypal", `Authorization failed for ${memberName(trip, c.memberId)}: ${c.lastError}`);
    }
    recomputeStatus(trip);
    return { found: true, ok: c.status === "AUTHORIZED", trip, c, already: false };
  });
}

/** Organizer finalizes: capture every authorization. */
export async function finalizeCommit(tripId: string, userId: string) {
  return updateStore(async (s) => {
    const trip = getTripOr404(s, tripId);
    requireOrganizer(trip, userId);
    recomputeStatus(trip);
    if (trip.status !== "COMMITTED") throw new HttpError(409, "The group is not fully committed yet");

    const now = Date.now();
    const toCapture = trip.commitments.filter((c) => c.status === "AUTHORIZED");
    // Guardrail: every hold must pay the same merchant PayPal reported when GroupCommit started.
    const wrongPayee = toCapture.filter((c) => trip.payee?.merchantId && c.payee?.merchantId && c.payee.merchantId !== trip.payee.merchantId);
    if (wrongPayee.length) throw new HttpError(409, `Capture blocked: ${wrongPayee.length} hold(s) pay a different merchant than ${trip.merchant}`);
    const expired = toCapture.filter((c) => c.expiresAt && Date.parse(c.expiresAt) < now);
    if (expired.length) throw new HttpError(409, `Authorization expired for ${expired.map((c) => memberName(trip, c.memberId)).join(", ")}`);

    for (const c of toCapture) {
      try {
        const r = await captureAuthorization(c.authorizationId!);
        if (r.status === "COMPLETED" || r.status === "PENDING") {
          c.status = "CAPTURED";
          c.captureId = r.captureId;
          addTimeline(trip, "paypal", `Captured ${formatMoney(c.cents, c.currency)} from ${memberName(trip, c.memberId)}${r.status === "PENDING" ? " (pending at PayPal)" : ""}`);
        } else {
          c.status = "CAPTURE_FAILED";
          c.lastError = `Capture status ${r.status}`;
        }
      } catch (e) {
        c.status = "CAPTURE_FAILED";
        c.lastError = errText(e);
        addTimeline(trip, "paypal", `Capture FAILED for ${memberName(trip, c.memberId)}: ${c.lastError}`);
      }
      c.updatedAt = nowIso();
    }

    if (trip.commitments.every((c) => ["CAPTURED", "CANCELLED", "VOIDED"].includes(c.status))) {
      trip.status = "FUNDED";
      addSystemMessage(trip, `✅ ${formatMoney(trip.totalCents, trip.currency)} collected via PayPal. Booking is FUNDED; confirm with ${trip.merchant}.`);
    } else {
      trip.status = "AT_RISK";
      addSystemMessage(trip, "⚠️ Some captures failed. The booking is at risk; see the commitment board.");
    }
    addTimeline(trip, "user", `${memberName(trip, userId)} finalized the booking`);
    return trip;
  });
}

/** Cancel the group booking: void every hold, cancel unapproved orders. */
export async function voidAll(tripId: string, userId: string, reason = "the group cancelled the booking") {
  return updateStore(async (s) => {
    const trip = getTripOr404(s, tripId);
    requireOrganizer(trip, userId);
    await voidAllInTrip(trip, reason);
    addTimeline(trip, "user", `${memberName(trip, userId)} cancelled the booking`);
    return trip;
  });
}

/** Void every hold in a trip (caller holds the store lock). Returns failure count. */
export async function voidAllInTrip(trip: Trip, reason: string): Promise<number> {
  if (["FUNDED", "CONFIRMED"].includes(trip.status) || trip.commitments.some((c) => c.status === "CAPTURED")) {
    throw new HttpError(409, "Money was already captured; this needs refunds, not a void");
  }
  {
    let failures = 0;
    for (const c of trip.commitments) {
      if (c.status === "AUTHORIZED") {
        try {
          await voidAuthorization(c.authorizationId!);
          c.status = "VOIDED";
          addTimeline(trip, "paypal", `Voided hold for ${memberName(trip, c.memberId)} (${formatMoney(c.cents, c.currency)} released)`);
        } catch (e) {
          failures++;
          c.lastError = errText(e);
        }
      } else if (c.status === "CREATED") {
        c.status = "CANCELLED";
      }
      c.updatedAt = nowIso();
    }
    if (failures === 0) {
      trip.status = "CANCELLED";
      addSystemMessage(trip, `🔓 Booking cancelled: ${reason}. All PayPal holds were released; nobody was charged.`);
    } else {
      addSystemMessage(trip, `⚠️ ${failures} hold(s) could not be voided. Retry Cancel.`);
    }
    return failures;
  }
}

/** Re-check one order with PayPal and repair our record if needed. */
export async function refreshCommitment(tripId: string, userId: string, orderId: string) {
  return updateStore(async (s) => {
    const trip = getTripOr404(s, tripId);
    requireMember(trip, userId);
    const c = trip.commitments.find((x) => x.orderId === orderId);
    if (!c) throw new HttpError(404, "Commitment not found");
    try {
      const o = await getOrder(orderId);
      if (c.status === "CREATED" && o.status === "APPROVED") {
        // Approved but never authorized (tab closed before redirect): authorize now.
        const r = await authorizeOrder(orderId);
        if (r.authorizationId) {
          c.status = "AUTHORIZED";
          c.authorizationId = r.authorizationId;
          c.expiresAt = r.expiresAt;
          addSystemMessage(trip, `🔒 ${memberName(trip, c.memberId)} committed ${formatMoney(c.cents, c.currency)}.`);
        }
      } else if (c.status === "CREATED" && o.authorizationId) {
        c.status = "AUTHORIZED";
        c.authorizationId = o.authorizationId;
        c.expiresAt = o.expiresAt;
      }
      addTimeline(trip, "paypal", `Checked order ${orderId}: PayPal status ${o.status}${o.authorizationStatus ? `, authorization ${o.authorizationStatus}` : ""}`);
      c.lastError = null;
    } catch (e) {
      c.lastError = errText(e);
    }
    c.updatedAt = nowIso();
    recomputeStatus(trip);
    return trip;
  });
}
