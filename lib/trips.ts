// Trip / plan logic (no PayPal calls here).
import {
  addSystemMessage,
  addTimeline,
  HttpError,
  nowIso,
  randomId,
  slugify,
  type Store,
  type Trip,
  type User,
} from "./store";
import { calculateShares, expensesTotal, SplitError } from "./splitEngine";
import { formatMoney } from "./money";

export function upsertUser(store: Store, user: User): User {
  const name = user.name.trim().slice(0, 40);
  if (!user.id || !name) throw new HttpError(400, "userId and name are required");
  const existing = store.users.find((u) => u.id === user.id);
  if (existing) return existing;
  const u = { id: user.id, name };
  store.users.push(u);
  return u;
}

export function getTripOr404(store: Store, tripId: string): Trip {
  const t = store.trips.find((x) => x.id === tripId);
  if (!t) throw new HttpError(404, "Trip not found");
  return t;
}

export function requireMember(trip: Trip, userId: string) {
  const m = trip.members.find((x) => x.userId === userId);
  if (!m) throw new HttpError(403, "You are not a member of this trip. Open the join link first.");
  return m;
}

export function requireOrganizer(trip: Trip, userId: string) {
  if (trip.organizerId !== userId) throw new HttpError(403, "Only the organizer can do this");
}

export function createTrip(
  store: Store,
  input: {
    user: User;
    name: string;
    merchant: string;
    totalCents: number;
    deadlineHours: number;
    merchantInfo?: Trip["merchantInfo"];
  },
): Trip {
  const user = upsertUser(store, input.user);
  const joinCode = newInviteCode(store);
  const trip: Trip = {
    id: `${slugify(input.name)}-${randomId(4).toLowerCase()}`,
    name: input.name.trim().slice(0, 60),
    merchant: input.merchant.trim().slice(0, 60),
    currency: "USD",
    totalCents: input.totalCents,
    stayCents: input.totalCents,
    merchantInfo: input.merchantInfo,
    deadline: new Date(Date.now() + input.deadlineHours * 3600_000).toISOString(),
    joinCode,
    organizerId: user.id,
    status: "PLANNING",
    createdAt: nowIso(),
    members: [{ userId: user.id, name: user.name, nights: 3, status: "ACTIVE", joinedAt: nowIso() }],
    plan: { version: 0, locked: false, surcharges: [], expenses: [], shares: [], approvals: {} },
    messages: [],
    commitments: [],
    proposals: [],
    ledger: [],
    timeline: [],
  };
  addSystemMessage(trip, `${user.name} created the trip: ${trip.merchant}, ${formatMoney(trip.totalCents, trip.currency)}.`);
  addTimeline(trip, "user", `${user.name} created the trip`);
  recalcPlan(trip);
  store.trips.push(trip);
  return trip;
}

/** WhatsApp-style invite code: 10 unambiguous chars, unique across trips. */
export function newInviteCode(store: Store): string {
  let code = randomId(10);
  while (store.trips.some((t) => t.joinCode === code)) code = randomId(10);
  return code;
}

export function findTripByCode(store: Store, code: string): Trip | undefined {
  const c = code.trim().toUpperCase();
  return c.length >= 4 ? store.trips.find((t) => t.joinCode.toUpperCase() === c) : undefined;
}

export function joinTrip(store: Store, trip: Trip, user: User) {
  const u = upsertUser(store, user);
  const existing = trip.members.find((m) => m.userId === u.id);
  if (existing) return existing; // no duplicate members
  if (trip.plan.locked) throw new HttpError(409, "GroupCommit already started; this trip is closed to new members");
  const m = { userId: u.id, name: u.name, nights: 3, status: "ACTIVE" as const, joinedAt: nowIso() };
  trip.members.push(m);
  addSystemMessage(trip, `${u.name} joined the trip.`);
  addTimeline(trip, "user", `${u.name} joined`);
  recalcPlan(trip);
  return m;
}

/**
 * Recompute shares from members' nights + surcharges. Bumps the plan version and
 * resets approvals whenever the shares actually change.
 */
/** The booking (stay) amount; older trips stored only totalCents. */
export function stayCentsOf(trip: Trip): number {
  if (trip.stayCents === undefined) trip.stayCents = trip.totalCents - expensesTotal(trip.plan.expenses);
  return trip.stayCents;
}

/** Shares for the current plan (stay by nights + shared expenses), optionally with other member states. */
export function planShares(trip: Trip, members = trip.members) {
  return calculateShares(stayCentsOf(trip), members, trip.plan.surcharges, trip.currency, trip.plan.expenses ?? []);
}

export function recalcPlan(trip: Trip): { changed: boolean } {
  if (trip.plan.locked) throw new HttpError(409, "Plan is locked because GroupCommit has started");
  let shares;
  try {
    shares = planShares(trip);
  } catch (e) {
    if (e instanceof SplitError) throw new HttpError(400, e.message);
    throw e;
  }
  trip.totalCents = stayCentsOf(trip) + expensesTotal(trip.plan.expenses);
  const before = JSON.stringify(trip.plan.shares.map((s) => [s.memberId, s.cents]));
  const after = JSON.stringify(shares.map((s) => [s.memberId, s.cents]));
  trip.plan.shares = shares;
  if (before !== after) {
    trip.plan.version += 1;
    trip.plan.approvals = {};
    return { changed: true };
  }
  return { changed: false };
}

export function allApproved(trip: Trip): boolean {
  const active = trip.members.filter((m) => m.status === "ACTIVE");
  return active.length > 0 && active.every((m) => trip.plan.approvals[m.userId] === trip.plan.version);
}

/** Money currently on hold or collected for active obligations. */
export function committedCents(trip: Trip): number {
  return trip.commitments
    .filter((c) => c.status === "AUTHORIZED" || c.status === "CAPTURED")
    .reduce((a, c) => a + c.cents, 0);
}

/** Recompute trip status from commitments (never leaves terminal states). */
export function recomputeStatus(trip: Trip) {
  if (["FUNDED", "CONFIRMED", "CANCELLED"].includes(trip.status)) return;
  if (!trip.plan.locked) {
    trip.status = "PLANNING";
    return;
  }
  const live = trip.commitments.filter((c) => c.status !== "CANCELLED" && c.status !== "VOIDED");
  if (live.some((c) => c.status === "CAPTURE_FAILED")) {
    trip.status = "AT_RISK";
    return;
  }
  const gap = trip.totalCents - committedCents(trip);
  if (gap <= 0 && live.length > 0 && live.every((c) => c.status === "AUTHORIZED" || c.status === "CAPTURED")) {
    trip.status = "COMMITTED";
    return;
  }
  if (trip.status !== "AT_RISK") trip.status = "COLLECTING";
}

/** Public, safe-to-send view of a trip with computed fields. */
export function tripView(trip: Trip) {
  const committed = committedCents(trip);
  return {
    ...trip,
    computed: {
      committedCents: committed,
      gapCents: Math.max(0, trip.totalCents - committed),
      allApproved: allApproved(trip),
      stayCents: trip.stayCents ?? trip.totalCents - expensesTotal(trip.plan.expenses),
      expensesCents: expensesTotal(trip.plan.expenses),
      /** null = not checkable yet (no order / no merchant email entered) */
      payeeMatchesMerchant:
        trip.payee?.email && trip.merchantInfo?.paypalEmail ? trip.payee.email.toLowerCase() === trip.merchantInfo.paypalEmail : null,
    },
  };
}
