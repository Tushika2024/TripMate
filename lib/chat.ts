// Shared group chat: one thread, one plan. AI turns run one at a time per process.
import {
  addTimeline,
  HttpError,
  memberName,
  nowIso,
  randomId,
  readStore,
  updateStore,
  type Trip,
} from "./store";
import { aiAvailable, answerLocked, fallbackInterpret, interpretMessage, type ChatExtraction, type LockedReply } from "./ai";
import { runAgent } from "./agent";
import { getTripOr404, recalcPlan, requireMember } from "./trips";
import { formatMoney, toCents } from "./money";

let aiQueue: Promise<unknown> = Promise.resolve();
function serialAi<T>(fn: () => Promise<T>): Promise<T> {
  const run = aiQueue.then(fn);
  aiQueue = run.catch(() => undefined);
  return run;
}

function planSummary(trip: Trip) {
  const lines = trip.plan.shares.map((s) => `• ${memberName(trip, s.memberId)}: ${formatMoney(s.cents, trip.currency)} (${s.explanation})`);
  return `📋 Plan v${trip.plan.version}\n${lines.join("\n")}\nTotal ${formatMoney(trip.totalCents, trip.currency)} ✓${(trip.plan.expenses ?? []).length ? ` (stay + ${(trip.plan.expenses ?? []).length} shared expense${(trip.plan.expenses ?? []).length > 1 ? "s" : ""})` : ""}. Everyone please re-approve your share.`;
}

/** Apply AI-extracted facts under the authority rules. Returns notes about what was refused. */
function applyExtraction(trip: Trip, senderId: string, x: ChatExtraction) {
  const isOrganizer = senderId === trip.organizerId;
  const confirmations = [...x.askConfirm];
  let applied = 0;

  for (const n of x.nights) {
    const m = trip.members.find((mm) => mm.userId === n.memberId);
    if (!m) continue;
    if (n.memberId === senderId) {
      if (m.nights !== n.nights) {
        m.nights = n.nights;
        applied++;
      }
    } else {
      // Someone else's statement about this member: they must confirm themselves.
      confirmations.push({ memberId: n.memberId, question: `${memberName(trip, senderId)} says you're staying ${n.nights} night(s). Is that right? Reply here to confirm.` });
    }
  }

  for (const s of x.surcharges) {
    if (!trip.members.some((m) => m.userId === s.memberId)) continue;
    if (s.memberId === senderId || isOrganizer) {
      trip.plan.surcharges = trip.plan.surcharges.filter((e) => e.memberId !== s.memberId);
      const cents = toCents(s.amountUsd);
      if (cents > 0) trip.plan.surcharges.push({ memberId: s.memberId, cents, reason: s.reason || "extra" });
      applied++;
    } else {
      confirmations.push({ memberId: s.memberId, question: `${memberName(trip, senderId)} suggested an extra of $${s.amountUsd} for you (${s.reason}). Please confirm.` });
    }
  }
  // Shared expenses: anyone may add one; it bumps the plan version, so every member re-approves.
  for (const e of x.expenses ?? []) {
    const list = trip.plan.expenses ?? [];
    const existing = list.find((ex) => ex.title.toLowerCase() === e.title.trim().toLowerCase());
    const cents = toCents(e.amountUsd);
    if (cents <= 0) {
      if (existing) trip.plan.expenses = list.filter((ex) => ex !== existing);
      continue;
    }
    const ids = e.participantIds.filter((pid) => trip.members.some((m) => m.userId === pid && m.status === "ACTIVE"));
    const entry = { id: existing?.id ?? randomId(8), title: e.title.trim().slice(0, 40), category: e.category, cents, participantIds: ids, addedBy: senderId };
    trip.plan.expenses = existing ? list.map((ex) => (ex === existing ? entry : ex)) : [...list, entry];
    applied++;
  }
  return { applied, confirmations };
}

const OFFLINE_HINT = "⚠️ TripMate's AI is unavailable right now (check GEMINI_API_KEY / GROQ_API_KEY on the server). You can still edit nights in the plan panel.";

/** Pending AI turns per trip, so "typing…" stays on until the last one finishes. */
const pendingTurns = new Map<string, number>();

/**
 * Saves the human message immediately and returns, so the chat feels instant for everyone.
 * TripMate's reply runs in the background (serialized so two people typing at once can't
 * fork the plan); every member sees "TripMate is typing…" via trip.aiTypingSince.
 */
export async function postMessage(tripId: string, senderId: string, text: string) {
  const clean = text.trim().slice(0, 1000);
  if (!clean) throw new HttpError(400, "Empty message");

  const trip = await updateStore((s) => {
    const t = getTripOr404(s, tripId);
    requireMember(t, senderId);
    t.messages.push({ id: randomId(10), at: nowIso(), from: senderId, text: clean });
    t.aiTypingSince = nowIso();
    return t;
  });

  pendingTurns.set(tripId, (pendingTurns.get(tripId) ?? 0) + 1);
  void serialAi(() => aiTurn(tripId, senderId, clean))
    .catch((e) => console.error("[ai] chat turn failed:", e))
    .finally(async () => {
      const left = (pendingTurns.get(tripId) ?? 1) - 1;
      pendingTurns.set(tripId, left);
      if (left <= 0) {
        await updateStore((s) => {
          const t = s.trips.find((x) => x.id === tripId);
          if (t) t.aiTypingSince = null;
        }).catch(() => undefined);
      }
    });
  return trip;
}

function pushAi(t: Trip, text: string) {
  t.messages.push({ id: randomId(10), at: nowIso(), from: "ai", text });
}

async function aiTurn(tripId: string, senderId: string, clean: string) {
  const snapshot = getTripOr404(await readStore(), tripId);

  // ---- GroupCommit running: answer questions, and call in the agent if someone can't pay.
  if (snapshot.plan.locked) {
    // Keyword fallback used when the LLM is unavailable.
    const wantsRecoveryKw = /agent|can'?t pay|cannot pay|won'?t pay|nahi (de|kar|ho)|drop|cover|cancel|extend/i.test(clean);
    let res: LockedReply;
    try {
      res = aiAvailable()
        ? await answerLocked(snapshot, senderId, clean)
        : { respond: /\?|tripmate/i.test(clean) || wantsRecoveryKw, reply: OFFLINE_HINT, wantsRecovery: wantsRecoveryKw };
    } catch (e) {
      console.error("[ai] locked answer failed:", (e as Error).message);
      res = { respond: true, reply: OFFLINE_HINT, wantsRecovery: wantsRecoveryKw };
    }
    if (res.respond || res.wantsRecovery) {
      await updateStore((s) => {
        const t = getTripOr404(s, tripId);
        pushAi(t, res.wantsRecovery ? `${res.reply}\n\n🤖 Let me check everyone's PayPal status and suggest options…` : res.reply);
      });
    }
    const live = ["COLLECTING", "AT_RISK"].includes(snapshot.status) && snapshot.commitments.some((c) => c.status === "CREATED");
    if (res.wantsRecovery && live) {
      try {
        await runAgent(tripId, senderId, "CHAT_REQUEST");
      } catch (e) {
        await updateStore((s) => pushAi(getTripOr404(s, tripId), `Couldn't run the agent: ${(e as Error).message}`));
      }
    }
    return;
  }

  // ---- Planning: extract plan facts; code does the math.
  let extraction: ChatExtraction;
  try {
    extraction = aiAvailable() ? await interpretMessage(snapshot, senderId, clean) : fallbackInterpret(clean, senderId);
  } catch (e) {
    console.error("[ai] interpret failed:", (e as Error).message);
    extraction = { ...fallbackInterpret(clean, senderId), respond: true };
    extraction.reply = `${OFFLINE_HINT}${extraction.nights.length ? "\n(Simple parser understood your nights.)" : ""}`;
  }

  // Apply to the CURRENT trip (it may have changed while the AI was thinking).
  await updateStore((s) => {
    const t = getTripOr404(s, tripId);
    let text = extraction.reply;
    let worthPosting = extraction.respond;
    if (t.plan.locked) {
      text += "\n(Plan got locked meanwhile; no changes applied.)";
    } else {
      const { confirmations } = applyExtraction(t, senderId, extraction);
      try {
        const { changed } = recalcPlan(t);
        if (changed) {
          text += `\n\n${planSummary(t)}`;
          worthPosting = true;
          addTimeline(t, "ai", `AI updated the plan to v${t.plan.version} from ${memberName(t, senderId)}'s message`);
        }
      } catch (e) {
        text += `\n\n⚠️ Couldn't apply that: ${(e as Error).message}`;
        worthPosting = true;
      }
      for (const c of confirmations) {
        text += `\n\n@${memberName(t, c.memberId)}: ${c.question}`;
        worthPosting = true;
      }
    }
    if (worthPosting && text.trim()) pushAi(t, text.trim());
  });
}
