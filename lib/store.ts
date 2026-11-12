import { promises as fs } from "fs";
import path from "path";

// ======================= Types =======================

export type TripStatus =
  | "PLANNING" // members join, plan is being agreed
  | "COLLECTING" // GroupCommit started, members authorizing
  | "AT_RISK" // deadline near / capture failed, agent involved
  | "COMMITTED" // every share is authorized (funds on hold) -> ready to finalize
  | "FUNDED" // all authorizations captured
  | "CONFIRMED" // organizer marked the hostel booking confirmed
  | "CANCELLED"; // group cancelled, holds voided

export type CommitmentStatus =
  | "CREATED" // PayPal order created, member hasn't approved yet
  | "AUTHORIZED" // funds on hold
  | "CAPTURED" // money collected
  | "CAPTURE_FAILED"
  | "VOIDED" // hold released
  | "CANCELLED"; // order replaced/abandoned before authorization

export interface User {
  id: string;
  name: string;
  email?: string; // lowercased, unique
  passwordHash?: string; // scrypt$salt$hash, never sent to the client
  createdAt?: string;
  resetTokenHash?: string | null; // sha256 of the one-time reset token
  resetTokenExpiresAt?: string | null;
}

export interface Member {
  userId: string;
  name: string;
  nights: number;
  status: "ACTIVE" | "DROPPED";
  joinedAt: string;
}

export interface Surcharge {
  memberId: string;
  cents: number;
  reason: string;
}

export interface Share {
  memberId: string;
  cents: number;
  explanation: string;
}

/** A shared cost on top of the stay (food, cab, activities), split equally among its participants. */
export interface Expense {
  id: string;
  title: string;
  category: "food" | "transport" | "activity" | "other";
  cents: number;
  participantIds: string[]; // empty = every active member
  addedBy: string;
}

/** Who actually receives the money at PayPal, as reported by PayPal itself on each order. */
export interface Payee {
  merchantId: string | null;
  email: string | null;
}

export interface Plan {
  version: number;
  locked: boolean;
  surcharges: Surcharge[];
  expenses?: Expense[];
  shares: Share[];
  /** memberId -> plan version they approved */
  approvals: Record<string, number>;
}

export interface Commitment {
  orderId: string;
  authorizationId: string | null;
  captureId: string | null;
  memberId: string; // who pays
  onBehalfOf: string | null; // cover payments
  kind: "SHARE" | "COVER" | "TOPUP";
  cents: number;
  currency: string;
  status: CommitmentStatus;
  approveUrl: string | null;
  expiresAt: string | null;
  createdBy: "system" | "agent";
  payee?: Payee | null;
  createdAt: string;
  updatedAt: string;
  lastError: string | null;
}

export interface Message {
  id: string;
  at: string;
  from: string; // userId | "ai" | "system"
  text: string;
  proposalId?: string; // agent recovery card
}

export type OptionType = "COVER" | "RESPLIT" | "EXTEND" | "CANCEL";

export interface ProposalOption {
  type: OptionType;
  title: string;
  detail: string; // deterministic description with exact amounts
  aiNote: string; // agent's explanation of consequences
  params: {
    covererId?: string;
    forMemberIds?: string[];
    cents?: number;
    dropMemberIds?: string[];
    deltas?: { memberId: string; cents: number }[];
    newDeadline?: string;
  };
  requiredApprovers: string[];
  votes: Record<string, "YES" | "NO">;
  status: "OPEN" | "EXECUTED" | "REJECTED" | "STALE" | "FAILED";
  error?: string;
}

export interface Proposal {
  id: string;
  createdAt: string;
  trigger: string;
  summary: string;
  recommended: OptionType | null;
  pendingMemberIds: string[];
  gapCents: number;
  /** if the situation changes before execution, the proposal goes STALE */
  fingerprint: string;
  paypalChecks: { orderId: string; status: string }[];
  aiPowered: boolean;
  aiModel?: string | null;
  status: "OPEN" | "RESOLVED" | "STALE";
  options: ProposalOption[];
}

export interface TimelineEntry {
  at: string;
  actor: "user" | "ai" | "paypal" | "webhook" | "system";
  text: string;
}

export interface LedgerEntry {
  from: string;
  to: string;
  cents: number;
  reason: string;
}

export interface Trip {
  id: string;
  name: string;
  merchant: string;
  currency: string; // USD (PayPal Agent Toolkit create_order supports USD)
  totalCents: number; // everything the group must fund = stay + shared expenses
  stayCents?: number; // the booking itself (older trips: equals totalCents)
  merchantInfo?: { paypalEmail?: string; bookingRef?: string; address?: string };
  /** Locked on the first PayPal order; every later order and the final capture must match it. */
  payee?: Payee | null;
  deadline: string;
  joinCode: string;
  organizerId: string;
  status: TripStatus;
  createdAt: string;
  members: Member[];
  plan: Plan;
  messages: Message[];
  commitments: Commitment[];
  proposals: Proposal[];
  ledger: LedgerEntry[];
  timeline: TimelineEntry[];
  /** set while TripMate is composing a reply (shown to everyone as "typing…") */
  aiTypingSince?: string | null;
  /** autopilot bookkeeping: which automatic nudges were already sent */
  autopilot?: { lastRunAt?: string; lastFingerprint?: string; notified?: string[] };
}

export interface Store {
  users: User[];
  trips: Trip[];
  processedWebhookIds: string[];
}

// ======================= Persistence =======================

const STORE_PATH = process.env.STORE_PATH || path.join(process.cwd(), "data", "store.json");

export function emptyStore(): Store {
  return { users: [], trips: [], processedWebhookIds: [] };
}

export async function readStore(): Promise<Store> {
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    const s = JSON.parse(raw) as Store;
    if (!Array.isArray(s.trips)) return emptyStore(); // old Phase 1 file
    return s;
  } catch {
    return emptyStore();
  }
}

export async function writeStore(store: Store): Promise<void> {
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
  const tmp = `${STORE_PATH}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2));
  await fs.rename(tmp, STORE_PATH);
}

// All writes go through one queue so concurrent requests can't clobber each other.
let queue: Promise<unknown> = Promise.resolve();

/**
 * Read-modify-write under a lock. IMPORTANT: if fn performs PayPal side effects,
 * it must catch its own errors and record them instead of throwing; a throw
 * discards all changes made in fn.
 */
export function updateStore<T>(fn: (s: Store) => T | Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const s = await readStore();
    const result = await fn(s);
    await writeStore(s);
    return result;
  });
  queue = run.catch(() => undefined);
  return run;
}

// ======================= Helpers =======================

export function nowIso() {
  return new Date().toISOString();
}

export function randomId(len = 6): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "trip";
}

export function findTrip(store: Store, tripId: string): Trip | undefined {
  return store.trips.find((t) => t.id === tripId);
}

export function memberName(trip: Trip, memberId: string): string {
  return trip.members.find((m) => m.userId === memberId)?.name ?? memberId;
}

export function addTimeline(trip: Trip, actor: TimelineEntry["actor"], text: string) {
  trip.timeline.push({ at: nowIso(), actor, text });
}

export function addSystemMessage(trip: Trip, text: string) {
  trip.messages.push({ id: randomId(10), at: nowIso(), from: "system", text });
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
