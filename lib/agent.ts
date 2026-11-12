// Commitment agent (LLM via lib/ai.ts): detects booking risk, verifies real PayPal state through the
// PayPal Agent Toolkit, and proposes recovery options that humans vote on.
// Guardrail design: amounts/params come from code; the AI recommends and explains;
// execution happens only after the required approvers vote YES.
import { generateObject, generateText, tool } from "ai";
import { z } from "zod";
import {
  addSystemMessage,
  addTimeline,
  HttpError,
  memberName,
  nowIso,
  randomId,
  readStore,
  updateStore,
  type Commitment,
  type OptionType,
  type Proposal,
  type ProposalOption,
  type Trip,
} from "./store";
import { aiAvailable, models, tripContext, withModel } from "./ai";
import { paypalReadTools } from "./paypalToolkit";
import { getOrder } from "./paypal";
import { SplitError } from "./splitEngine";
import { createCommitment, voidAllInTrip } from "./commit";
import { getTripOr404, planShares, recomputeStatus, requireMember } from "./trips";
import { formatMoney } from "./money";

const EXTEND_MS = 2 * 3600_000;

function pending(trip: Trip): Commitment[] {
  return trip.commitments.filter((c) => c.status === "CREATED");
}

/** Changes whenever the payment situation changes; stale proposals can't execute. */
export function fingerprint(trip: Trip) {
  return JSON.stringify(
    trip.commitments
      .filter((c) => c.status !== "CANCELLED")
      .map((c) => [c.orderId, c.status, c.cents])
      .sort(),
  );
}

function earliestExpiry(trip: Trip): number | null {
  const t = trip.commitments
    .filter((c) => c.status === "AUTHORIZED" && c.expiresAt)
    .map((c) => Date.parse(c.expiresAt!));
  return t.length ? Math.min(...t) : null;
}

/** Deterministic recovery options with exact amounts. */
export function buildOptions(trip: Trip, preferredCoverer?: string) {
  const open = pending(trip);
  const pendingIds = [...new Set(open.map((c) => c.memberId))];
  const gap = open.reduce((a, c) => a + c.cents, 0);
  const options: ProposalOption[] = [];
  if (open.length === 0) return { pendingIds, gap, options };

  const names = (ids: string[]) => ids.map((id) => memberName(trip, id)).join(", ");
  const active = trip.members.filter((m) => m.status === "ACTIVE" && !pendingIds.includes(m.userId));
  const base = { aiNote: "", votes: {}, status: "OPEN" as const };

  // COVER
  const coverer =
    (preferredCoverer && active.some((m) => m.userId === preferredCoverer) && preferredCoverer) ||
    (active.some((m) => m.userId === trip.organizerId) ? trip.organizerId : active[0]?.userId);
  if (coverer) {
    options.push({
      ...base,
      type: "COVER",
      title: `${memberName(trip, coverer)} covers ${names(pendingIds)}`,
      detail: `${memberName(trip, coverer)} authorizes ${formatMoney(gap, trip.currency)} more on PayPal. ${names(pendingIds)} then ${pendingIds.length > 1 ? "owe" : "owes"} ${memberName(trip, coverer)} that amount.`,
      params: { covererId: coverer, forMemberIds: pendingIds, cents: gap },
      requiredApprovers: [coverer],
    });
  }

  // RESPLIT (pending members drop out; the rest top up the difference)
  if (active.length > 0) {
    try {
      const members = trip.members.map((m) => (pendingIds.includes(m.userId) ? { ...m, status: "DROPPED" as const } : m));
      const newShares = planShares(trip, members);
      const deltas = newShares
        .map((s) => {
          const existing = trip.commitments
            .filter((c) => c.memberId === s.memberId && !c.onBehalfOf && ["AUTHORIZED", "CAPTURED"].includes(c.status))
            .reduce((a, c) => a + c.cents, 0);
          return { memberId: s.memberId, cents: s.cents - existing };
        })
        .filter((d) => d.cents > 0);
      if (deltas.length) {
        options.push({
          ...base,
          type: "RESPLIT",
          title: `${names(pendingIds)} drop${pendingIds.length > 1 ? "" : "s"} out; re-split among ${active.length}`,
          detail: `Top-ups: ${deltas.map((d) => `${memberName(trip, d.memberId)} +${formatMoney(d.cents, trip.currency)}`).join(", ")}. Each top-up is a new PayPal authorization.`,
          params: { dropMemberIds: pendingIds, deltas },
          requiredApprovers: [...new Set([...deltas.map((d) => d.memberId), trip.organizerId])],
        });
      }
    } catch (e) {
      if (!(e instanceof SplitError)) throw e;
    }
  }

  // EXTEND (only if every existing hold outlives the new deadline)
  const newDeadline = Math.max(Date.now(), Date.parse(trip.deadline)) + EXTEND_MS;
  const exp = earliestExpiry(trip);
  if (exp === null || newDeadline < exp) {
    options.push({
      ...base,
      type: "EXTEND",
      title: "Extend the deadline by 2 hours",
      detail: `New deadline ${new Date(newDeadline).toUTCString()}. Existing holds stay valid${exp ? ` (earliest expires ${new Date(exp).toUTCString()})` : ""}. ${names(pendingIds)} ${pendingIds.length > 1 ? "get" : "gets"} a reminder.`,
      params: { newDeadline: new Date(newDeadline).toISOString(), forMemberIds: pendingIds },
      requiredApprovers: [trip.organizerId],
    });
  }

  // CANCEL
  options.push({
    ...base,
    type: "CANCEL",
    title: "Cancel the booking and release every hold",
    detail: `All PayPal authorizations are voided. Nobody is charged.`,
    params: {},
    requiredApprovers: [trip.organizerId],
  });

  return { pendingIds, gap, options };
}

// ---------------------------------------------------------------- run agent

/**
 * userId = the member who asked, or null when the autopilot triggers the agent on its own.
 * The agent only PROPOSES; nothing executes until the required humans vote YES.
 */
export async function runAgent(tripId: string, userId: string | null, trigger: string) {
  const snap = getTripOr404(await readStore(), tripId);
  if (userId) requireMember(snap, userId);
  if (!snap.plan.locked || ["FUNDED", "CONFIRMED", "CANCELLED"].includes(snap.status)) {
    throw new HttpError(409, "The agent works while GroupCommit is collecting commitments");
  }
  // Don't spam the chat: an open proposal for this exact situation already exists.
  if (snap.proposals.some((p) => p.status === "OPEN" && p.fingerprint === fingerprint(snap))) {
    if (!userId) return snap;
  }

  const checks: { orderId: string; status: string }[] = [];
  let recommended: OptionType | null = null;
  let covererPick: string | undefined;
  let summary = "";
  const notes: Partial<Record<OptionType, string>> = {};
  let aiPowered = false;
  let aiModel: string | null = null;

  const initial = buildOptions(snap);
  if (initial.options.length === 0) {
    await updateStore((s) => {
      const t = getTripOr404(s, tripId);
      t.messages.push({ id: randomId(10), at: nowIso(), from: "ai", text: "Everyone has committed; nothing to recover. The organizer can finalize." });
    });
    return getTripOr404(await readStore(), tripId);
  }

  // Multi-step tool loop: Groq (Llama) handles it; Gemini 3 needs thought signatures that AI SDK v4 can't send,
  // so with Gemini we go straight to the structured plan B below.
  if (models().some((x) => x.label.startsWith("Groq"))) {
    try {
      const pp = paypalReadTools();
      const ppGet = pp.get_order;
      const tools = {
        get_commitment_status: tool({
          description: "Current GroupCommit state: members, commitments, gap, deadline, hold expiries and the recovery options the backend can execute (with exact amounts).",
          parameters: z.object({ includeContext: z.boolean().optional().describe("Include full trip context (default true)") }),
          execute: async () => ({
            now: nowIso(),
            deadline: snap.deadline,
            earliestHoldExpiry: earliestExpiry(snap) ? new Date(earliestExpiry(snap)!).toISOString() : null,
            gap: formatMoney(initial.gap, snap.currency),
            pendingOrders: pending(snap).map((c) => ({ orderId: c.orderId, member: memberName(snap, c.memberId), memberId: c.memberId, amount: formatMoney(c.cents, c.currency) })),
            context: tripContext(snap),
            availableOptions: initial.options.map((o) => ({ type: o.type, title: o.title, detail: o.detail })),
          }),
        }),
        // Official PayPal Agent Toolkit tool, wrapped only to record what PayPal said.
        get_order: tool({
          description: ppGet.description ?? "Get a PayPal order",
          parameters: z.object({ id: z.string().describe("PayPal order id") }),
          execute: async (args, opts) => {
            const raw = (await ppGet.execute!(args, opts)) as string;
            let status = "UNKNOWN";
            try {
              status = JSON.parse(raw)?.status ?? "UNKNOWN";
            } catch {}
            checks.push({ orderId: args.id, status });
            return raw.slice(0, 1500);
          },
        }),
        submit_recommendation: tool({
          description: "Submit the final recommendation for the group. Call exactly once, at the end.",
          parameters: z.object({
            recommended: z.enum(["COVER", "RESPLIT", "EXTEND", "CANCEL"]),
            covererMemberId: z.string().optional().describe("For COVER: which non-pending member should cover (defaults to organizer)."),
            summary: z.string().describe("2-4 sentences for the group chat: what PayPal shows, the risk, and why you recommend this option. Hinglish ok. No invented facts."),
            notes: z
              .object({ COVER: z.string().optional(), RESPLIT: z.string().optional(), EXTEND: z.string().optional(), CANCEL: z.string().optional() })
              .describe("One short consequence note per available option."),
          }),
          execute: async (a) => {
            recommended = a.recommended;
            covererPick = a.covererMemberId;
            summary = a.summary;
            Object.assign(notes, a.notes);
            return { ok: true };
          },
        }),
      };

      const run = await withModel(async (m) => {
        // reset anything a failed attempt on another provider may have recorded
        checks.length = 0;
        summary = "";
        return generateText({
        model: m,
        maxSteps: 8,
        tools,
        system: `You are TripMate's commitment agent for a group booking that uses PayPal authorizations (holds).
Process: 1) call get_commitment_status; 2) verify EVERY pending order with get_order (real PayPal state; an order still CREATED/PAYER_ACTION_REQUIRED means the member hasn't committed); 3) call submit_recommendation once.
You cannot move money. Humans approve; the backend executes the exact amounts it listed. Only recommend options that appear in availableOptions. Prefer keeping the booking alive when holds are healthy; prefer EXTEND only if there is time; recommend CANCEL if the group can't fund it.`,
        prompt: `Trigger: ${trigger}. Analyse trip "${snap.name}" and recommend a recovery plan.`,
        });
      }, (label) => label.startsWith("Groq"));
      aiPowered = Boolean(summary);
      aiModel = aiPowered ? run.label : null;
    } catch (e) {
      console.error("[agent] AI run failed:", e);
    }
  }

  // Plan B (e.g. Gemini 3 rejects multi-step tool calls from AI SDK v4 without thought signatures):
  // code calls the PayPal Agent Toolkit get_order tool for every pending order, then ONE structured
  // LLM call reads those results and recommends. Still PayPal-verified, still AI-explained.
  if (!aiPowered && aiAvailable()) {
    try {
      checks.length = 0;
      const ppGet = paypalReadTools().get_order;
      for (const c of pending(snap)) {
        let status = "UNREACHABLE";
        try {
          const raw = (await ppGet.execute!({ id: c.orderId }, { toolCallId: `auto-${c.orderId}`, messages: [] } as never)) as string;
          status = JSON.parse(raw)?.status ?? "UNKNOWN";
        } catch {}
        checks.push({ orderId: c.orderId, status });
      }
      const Rec = z.object({
        recommended: z.enum(["COVER", "RESPLIT", "EXTEND", "CANCEL"]),
        covererMemberId: z.string().describe("For COVER: member id of the non-pending member who should cover; empty string for default"),
        summary: z.string().describe("2-4 sentences for the group chat: what PayPal shows, the risk, and why you recommend this option. Hinglish ok. No invented facts."),
        notes: z.object({ COVER: z.string(), RESPLIT: z.string(), EXTEND: z.string(), CANCEL: z.string() }).describe("One short consequence note per option; empty string if the option is not available."),
      });
      const { result, label } = await withModel(async (m) => (await generateObject({
        model: m,
        schema: Rec,
        maxRetries: 1,
        system: `You are TripMate's commitment agent for a group booking that uses PayPal authorizations (holds).
You cannot move money. Humans approve; the backend executes the exact amounts listed. Only recommend options in availableOptions.
An order in CREATED/PAYER_ACTION_REQUIRED means that member hasn't committed. Prefer keeping the booking alive when holds are healthy; prefer EXTEND only if there is time; recommend CANCEL if the group can't fund it.`,
        prompt: `Trigger: ${trigger}. Trip "${snap.name}".
Commitment status: ${JSON.stringify({
          now: nowIso(),
          deadline: snap.deadline,
          earliestHoldExpiry: earliestExpiry(snap) ? new Date(earliestExpiry(snap)!).toISOString() : null,
          gap: formatMoney(initial.gap, snap.currency),
          pendingOrders: pending(snap).map((c) => ({ orderId: c.orderId, member: memberName(snap, c.memberId), memberId: c.memberId, amount: formatMoney(c.cents, c.currency) })),
          context: tripContext(snap),
          availableOptions: initial.options.map((o) => ({ type: o.type, title: o.title, detail: o.detail })),
        })}
PayPal Agent Toolkit get_order results: ${JSON.stringify(checks)}`,
      })).object);
      recommended = result.recommended;
      covererPick = result.covererMemberId || undefined;
      summary = result.summary;
      for (const k of ["COVER", "RESPLIT", "EXTEND", "CANCEL"] as const) if (result.notes[k]) notes[k] = result.notes[k];
      aiPowered = Boolean(summary);
      aiModel = aiPowered ? label : null;
    } catch (e) {
      console.error("[agent] structured fallback failed:", (e as Error).message);
    }
  }

  // Fallback (no API key / AI error): still verify with PayPal and propose options.
  if (!aiPowered) {
    checks.length = 0;
    for (const c of pending(snap)) {
      try {
        const o = await getOrder(c.orderId);
        checks.push({ orderId: c.orderId, status: o.status });
      } catch {
        checks.push({ orderId: c.orderId, status: "UNREACHABLE" });
      }
    }
    recommended = initial.options.some((o) => o.type === "COVER") ? "COVER" : "CANCEL";
    summary = `Booking at risk: ${initial.pendingIds.map((id) => memberName(snap, id)).join(", ")} ha${initial.pendingIds.length > 1 ? "ve" : "s"} not committed (${formatMoney(initial.gap, snap.currency)} gap). PayPal confirms the order${checks.length > 1 ? "s are" : " is"} not approved yet. Choose a recovery option below.`;
  }

  return updateStore(async (s) => {
    const t = getTripOr404(s, tripId);
    const built = buildOptions(t, covererPick);
    if (built.options.length === 0) {
      t.messages.push({ id: randomId(10), at: nowIso(), from: "ai", text: "Everyone committed while I was checking. Nothing to recover." });
      return t;
    }
    if (!userId && t.proposals.some((p) => p.status === "OPEN" && p.fingerprint === fingerprint(t))) return t;
    for (const o of built.options) o.aiNote = notes[o.type] ?? "";
    for (const p of t.proposals) if (p.status === "OPEN") p.status = "STALE";

    const proposal: Proposal = {
      id: randomId(8),
      createdAt: nowIso(),
      trigger,
      summary,
      recommended: built.options.some((o) => o.type === recommended) ? recommended : null,
      pendingMemberIds: built.pendingIds,
      gapCents: built.gap,
      fingerprint: fingerprint(t),
      paypalChecks: checks,
      aiPowered,
      aiModel,
      status: "OPEN",
      options: built.options,
    };
    t.proposals.push(proposal);
    t.status = "AT_RISK";
    for (const c of checks) {
      addTimeline(t, "ai", `Agent verified order ${c.orderId} with PayPal${aiPowered ? ` Agent Toolkit get_order (${aiModel})` : ""}: ${c.status}`);
    }
    addTimeline(t, "ai", `Agent proposed recovery options (recommended: ${proposal.recommended ?? "none"})`);
    const who = userId ? `${memberName(t, userId)} asked me to check` : "🤖 Autopilot";
    const approvers = [...new Set(built.options.flatMap((o) => o.requiredApprovers))].map((id) => `@${memberName(t, id)}`).join(" ");
    t.messages.push({
      id: randomId(10),
      at: nowIso(),
      from: "ai",
      text: `⚠️ ${who} (${trigger.replace(/_/g, " ").toLowerCase()}): ${summary}

Nothing happens until you approve. ${approvers} please vote below.`,
      proposalId: proposal.id,
    });
    return t;
  });
}

// ---------------------------------------------------------------- votes + execution

export async function vote(
  tripId: string,
  proposalId: string,
  optionType: OptionType,
  userId: string,
  decision: "YES" | "NO",
  baseUrl: string,
) {
  return updateStore(async (s) => {
    const t = getTripOr404(s, tripId);
    requireMember(t, userId);
    const p = t.proposals.find((x) => x.id === proposalId);
    if (!p) throw new HttpError(404, "Proposal not found");
    if (p.status !== "OPEN") throw new HttpError(409, `This proposal is ${p.status.toLowerCase()}. Ask the agent again.`);
    const o = p.options.find((x) => x.type === optionType);
    if (!o || o.status !== "OPEN") throw new HttpError(409, "This option is no longer open");
    if (!o.requiredApprovers.includes(userId)) throw new HttpError(403, "Your approval isn't required for this option");

    o.votes[userId] = decision;
    addTimeline(t, "user", `${memberName(t, userId)} voted ${decision} on "${o.title}"`);

    if (decision === "NO") {
      o.status = "REJECTED";
      addSystemMessage(t, `${memberName(t, userId)} declined: ${o.title}.`);
      return t;
    }
    if (!o.requiredApprovers.every((a) => o.votes[a] === "YES")) {
      const waiting = o.requiredApprovers.filter((a) => o.votes[a] !== "YES").map((a) => memberName(t, a));
      addSystemMessage(t, `${memberName(t, userId)} approved "${o.title}". Waiting for: ${waiting.join(", ")}.`);
      return t;
    }

    // Guardrail: the situation must be exactly what the proposal was built for.
    if (p.fingerprint !== fingerprint(t)) {
      p.status = "STALE";
      addSystemMessage(t, "The payment situation changed since this proposal was made, so it was not executed. Ask the agent again.");
      return t;
    }

    try {
      await execute(t, o, baseUrl);
      o.status = "EXECUTED";
      p.status = "RESOLVED";
      for (const other of p.options) if (other !== o && other.status === "OPEN") other.status = "STALE";
      addTimeline(t, "system", `Executed approved option: ${o.title}`);
    } catch (e) {
      o.status = "FAILED";
      o.error = e instanceof Error ? e.message : String(e);
      addSystemMessage(t, `⚠️ Could not execute "${o.title}": ${o.error}`);
    }
    recomputeStatus(t);
    return t;
  });
}

async function execute(t: Trip, o: ProposalOption, baseUrl: string) {
  const prm = o.params;
  switch (o.type) {
    case "COVER": {
      const forIds = prm.forMemberIds ?? [];
      const c = await createCommitment(t, {
        memberId: prm.covererId!,
        cents: prm.cents!,
        kind: "COVER",
        onBehalfOf: forIds[0] ?? null,
        createdBy: "agent",
        baseUrl,
      });
      for (const old of t.commitments) {
        if (old.status === "CREATED" && forIds.includes(old.memberId) && old !== c) {
          old.status = "CANCELLED";
          t.ledger.push({ from: old.memberId, to: prm.covererId!, cents: old.cents, reason: `${memberName(t, prm.covererId!)} covered this share` });
        }
      }
      if (t.status === "AT_RISK") t.status = "COLLECTING";
      addSystemMessage(t, `🤝 Approved: ${memberName(t, prm.covererId!)} covers ${forIds.map((id) => memberName(t, id)).join(", ")}. ${memberName(t, prm.covererId!)}, open your new "Commit with PayPal" link (${formatMoney(prm.cents!, t.currency)}).`);
      return;
    }
    case "RESPLIT": {
      const created: Commitment[] = [];
      for (const d of prm.deltas ?? []) {
        created.push(await createCommitment(t, { memberId: d.memberId, cents: d.cents, kind: "TOPUP", createdBy: "agent", baseUrl }));
      }
      for (const id of prm.dropMemberIds ?? []) {
        const m = t.members.find((x) => x.userId === id);
        if (m) m.status = "DROPPED";
      }
      for (const old of t.commitments) {
        if (old.status === "CREATED" && (prm.dropMemberIds ?? []).includes(old.memberId) && !created.includes(old)) old.status = "CANCELLED";
      }
      t.plan.shares = planShares(t);
      t.plan.version += 1;
      if (t.status === "AT_RISK") t.status = "COLLECTING";
      addSystemMessage(t, `🔁 Approved re-split (plan v${t.plan.version}). Top-ups: ${(prm.deltas ?? []).map((d) => `${memberName(t, d.memberId)} +${formatMoney(d.cents, t.currency)}`).join(", ")}. Please commit your top-up link.`);
      return;
    }
    case "EXTEND": {
      t.deadline = prm.newDeadline!;
      if (t.status === "AT_RISK") t.status = "COLLECTING";
      addSystemMessage(t, `⏰ Deadline extended to ${new Date(t.deadline).toUTCString()}. ${(prm.forMemberIds ?? []).map((id) => `@${memberName(t, id)}`).join(" ")} please commit your share.`);
      return;
    }
    case "CANCEL": {
      const failures = await voidAllInTrip(t, "the group approved cancelling");
      if (failures) throw new Error(`${failures} hold(s) could not be voided`);
      return;
    }
  }
}
