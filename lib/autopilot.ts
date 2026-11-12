// Autopilot: the commitment agent runs by itself — no button needed.
// It watches every collecting trip and, when the deadline gets close (or passes) while
// someone still hasn't committed, it runs the agent (PayPal Agent Toolkit checks + AI
// recommendation) and posts a proposal. HUMAN IN THE LOOP: it never moves money;
// options execute only after the required members vote YES.
// It also nudges the organizer when every hold is in place (capture stays a human click).
import { addTimeline, nowIso, randomId, readStore, updateStore, memberName, type Trip } from "./store";
import { fingerprint, runAgent } from "./agent";

/** Agent wakes up when this much time (or less) is left before the deadline. */
const NEAR_MS = 35 * 60_000;
const TICK_MS = 30_000;

const running = new Set<string>();
const lastSoon = new Map<string, number>();

function situationKey(t: Trip) {
  return `${fingerprint(t)}|${t.deadline}`;
}

function needsAgent(t: Trip): string | null {
  if (!t.plan.locked) return null;
  if (!["COLLECTING", "AT_RISK"].includes(t.status)) return null;
  if (!t.commitments.some((c) => c.status === "CREATED")) return null;
  if (t.proposals.some((p) => p.status === "OPEN")) return null; // humans are deciding already
  const left = Date.parse(t.deadline) - Date.now();
  if (left > NEAR_MS) return null;
  if (t.autopilot?.lastFingerprint === situationKey(t)) return null; // already handled this exact situation
  return left <= 0 ? "AUTO_DEADLINE_PASSED" : "AUTO_DEADLINE_NEAR";
}

async function evaluate(tripId: string) {
  if (running.has(tripId)) return;
  running.add(tripId);
  try {
    const snap = (await readStore()).trips.find((t) => t.id === tripId);
    if (!snap) return;

    // 1) Everyone committed -> ask the organizer to finalize (capture stays a human decision).
    if (snap.status === "COMMITTED") {
      const key = `ready:${fingerprint(snap)}`;
      if (!snap.autopilot?.notified?.includes(key)) {
        await updateStore((s) => {
          const t = s.trips.find((x) => x.id === tripId);
          if (!t || t.status !== "COMMITTED") return;
          t.autopilot = { ...t.autopilot, notified: [...(t.autopilot?.notified ?? []), key] };
          t.messages.push({
            id: randomId(10),
            at: nowIso(),
            from: "ai",
            text: `✅ Autopilot: every share is on hold with PayPal. @${memberName(t, t.organizerId)}, tap "Finalize: capture all" when you're ready to book. Nothing is charged until you do.`,
          });
          addTimeline(t, "ai", "Autopilot: all holds in place, asked organizer to finalize");
        });
      }
      return;
    }

    // 2) Deadline near/passed with pending members -> agent proposes recovery options.
    const trigger = needsAgent(snap);
    if (!trigger) return;
    await updateStore((s) => {
      const t = s.trips.find((x) => x.id === tripId);
      if (t) t.autopilot = { ...t.autopilot, lastRunAt: nowIso(), lastFingerprint: situationKey(t) };
    });
    console.log(`[autopilot] ${tripId}: ${trigger} -> running commitment agent`);
    await runAgent(tripId, null, trigger);
  } catch (e) {
    console.error(`[autopilot] ${tripId} failed:`, (e as Error).message);
  } finally {
    running.delete(tripId);
  }
}

/** Check one trip (or all trips) right now. */
export async function autopilotTick(tripId?: string) {
  if (tripId) return evaluate(tripId);
  const store = await readStore();
  const ids = store.trips.filter((t) => t.plan.locked && ["COLLECTING", "AT_RISK", "COMMITTED"].includes(t.status)).map((t) => t.id);
  for (const id of ids) await evaluate(id);
}

/** Fire-and-forget check, throttled per trip (called from the polled GET route). */
export function autopilotSoon(tripId: string) {
  const now = Date.now();
  if (now - (lastSoon.get(tripId) ?? 0) < 10_000) return;
  lastSoon.set(tripId, now);
  void evaluate(tripId);
}

/** Background loop, started once per server process from instrumentation.ts. */
export function startAutopilot() {
  const g = globalThis as unknown as { __tmAutopilot?: NodeJS.Timeout };
  if (g.__tmAutopilot) return;
  g.__tmAutopilot = setInterval(() => void autopilotTick().catch(() => undefined), TICK_MS);
  console.log("[autopilot] started (checks every 30s)");
}
