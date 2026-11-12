// LLM access via the Vercel AI SDK. The AI interprets language; code owns the money math.
// Free providers: Google Gemini (AI Studio key) first, Groq as automatic fallback.
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { generateObject, type LanguageModelV1 } from "ai";
import { z } from "zod";
import type { Trip } from "./store";
import { formatMoney } from "./money";

interface NamedModel {
  label: string;
  model: LanguageModelV1;
}

/** Configured models in priority order (AI_PROVIDER=groq puts Groq first). */
export function models(): NamedModel[] {
  const list: NamedModel[] = [];
  if (process.env.GEMINI_API_KEY) {
    // Comma-separated list = Gemini models to try in order (older 2.x models are closed to new keys).
    const google = createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY });
    const ids = (process.env.GEMINI_MODEL || DEFAULT_GEMINI).split(",").map((x) => x.trim()).filter(Boolean);
    if (!ids.includes("gemini-flash-lite-latest")) ids.push("gemini-flash-lite-latest");
    for (const id of ids) list.push({ label: `Gemini (${id})`, model: google(id) });
  }
  if (process.env.GROQ_API_KEY) {
    const id = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
    list.push({ label: `Groq (${id})`, model: createGroq({ apiKey: process.env.GROQ_API_KEY })(id) });
  }
  if ((process.env.AI_PROVIDER || "").toLowerCase() === "groq") list.reverse();
  return list;
}

export function aiAvailable() {
  return models().length > 0;
}

const DEFAULT_GEMINI = "gemini-3.5-flash-lite";
const MODEL_TIMEOUT_MS = 30_000;

function withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${MODEL_TIMEOUT_MS / 1000}s`)), MODEL_TIMEOUT_MS);
    p.then(resolve, reject).finally(() => clearTimeout(t));
  });
}

/** Run fn with the first model; on failure (rate limit, outage, timeout) fall back to the next. */
export async function withModel<T>(fn: (m: LanguageModelV1, label: string) => Promise<T>, only?: (label: string) => boolean): Promise<{ result: T; label: string }> {
  let last: unknown = new Error("No AI provider configured (set GEMINI_API_KEY or GROQ_API_KEY)");
  for (const { model, label } of models().filter((x) => !only || only(x.label))) {
    try {
      return { result: await withTimeout(fn(model, label), label), label };
    } catch (e) {
      console.warn(`[ai] ${label} failed, trying next provider:`, (e as Error).message);
      last = e;
    }
  }
  throw last;
}

/** Compact, factual trip context for prompts. */
export function tripContext(trip: Trip) {
  const name = (id: string) => trip.members.find((m) => m.userId === id)?.name ?? id;
  return {
    trip: { name: trip.name, merchant: trip.merchant, total: formatMoney(trip.totalCents, trip.currency), deadline: trip.deadline, status: trip.status },
    organizer: { id: trip.organizerId, name: name(trip.organizerId) },
    members: trip.members.map((m) => ({ id: m.userId, name: m.name, nights: m.nights, status: m.status })),
    surcharges: trip.plan.surcharges.map((s) => ({ memberId: s.memberId, name: name(s.memberId), amount: formatMoney(s.cents, trip.currency), reason: s.reason })),
    sharedExpenses: (trip.plan.expenses ?? []).map((e) => ({ title: e.title, category: e.category, amount: formatMoney(e.cents, trip.currency), splitBetween: e.participantIds.length ? e.participantIds.map(name) : "everyone" })),
    planVersion: trip.plan.version,
    planLocked: trip.plan.locked,
    shares: trip.plan.shares.map((s) => ({ name: name(s.memberId), amount: formatMoney(s.cents, trip.currency) })),
    commitments: trip.commitments.map((c) => ({ member: name(c.memberId), onBehalfOf: c.onBehalfOf ? name(c.onBehalfOf) : null, kind: c.kind, amount: formatMoney(c.cents, c.currency), status: c.status })),
  };
}

function recentChat(trip: Trip, n = 12) {
  const name = (id: string) => (id === "ai" ? "TripMate" : id === "system" ? "system" : (trip.members.find((m) => m.userId === id)?.name ?? id));
  return trip.messages.slice(-n).map((m) => `${name(m.from)}: ${m.text}`).join("\n");
}

// ---------------- Chat turn: message -> plan facts ----------------

export const ChatExtraction = z.object({
  respond: z
    .boolean()
    .describe("true if TripMate should post a reply: plan facts were found, someone asked TripMate/the group a trip question, or greeted TripMate. false for casual banter between friends that needs no assistant."),
  reply: z.string().describe("Short, friendly reply to the group in the sender's language/style (Hinglish is fine). Do NOT state any money amounts; the app appends the exact plan."),
  nights: z
    .array(z.object({ memberId: z.string(), nights: z.number().int().min(0).max(60) }))
    .describe("Nights changes explicitly stated in the NEW message only."),
  surcharges: z
    .array(z.object({ memberId: z.string(), amountUsd: z.number().min(0).max(5000), reason: z.string().max(40) }))
    .describe("Extras one member pays on top of the per-night split (e.g. private room). amountUsd 0 removes an existing extra."),
  expenses: z
    .array(
      z.object({
        title: z.string().max(40).describe("Short name, e.g. 'Dinner at Thalassa', 'Airport cab', 'Scuba diving'"),
        category: z.enum(["food", "transport", "activity", "other"]),
        amountUsd: z.number().min(0).max(10000).describe("0 removes an existing shared expense with this title"),
        participantIds: z.array(z.string()).describe("Member ids who share this cost; EMPTY array = everyone"),
      }),
    )
    .describe("Shared costs on top of the stay (food, cabs, activities, tickets) mentioned in the NEW message."),
  askConfirm: z
    .array(z.object({ memberId: z.string(), question: z.string() }))
    .describe("Members who must confirm something said about them by someone else."),
});
export type ChatExtraction = z.infer<typeof ChatExtraction>;

export async function interpretMessage(trip: Trip, senderId: string, text: string): Promise<ChatExtraction> {
  const ctx = tripContext(trip);
  const sender = trip.members.find((m) => m.userId === senderId);
  const { result: object } = await withModel(async (m) => (await generateObject({
    model: m,
    schema: ChatExtraction,
    system: `You are TripMate, the shared assistant inside a group-trip chat. All members see the same chat and there is exactly ONE plan.
Your job: read the NEW message and extract only explicit plan facts. The app's code does all arithmetic.
Rules:
- Only extract changes stated in the NEW message. Never invent facts. Use member ids from the context.
- A member's statement about THEMSELF is authoritative. If someone states nights or extras for ANOTHER member, do not put it in nights/surcharges for that member; add an askConfirm for that member instead (unless the sender is the organizer adding an extra).
- "Main/I" refers to the sender.
- If the message is just a question, return empty arrays and answer it briefly from the context.
- If it's casual banter between friends with no plan facts and no question for you, set respond=false.
- Shared costs beyond the stay (food, dinner, cab, fuel, tickets, activities) go in expenses, NOT surcharges. Surcharges are only room upgrades one person pays for. "sabka/everyone/all of us" = empty participantIds.
- Members write in English, Hindi or Hinglish ("raat" = night, "main/mai" = I, "sirf" = only, "extra dunga/dungi" = I'll pay extra).
- Never mention specific share amounts; never promise payments or bookings.`,
    prompt: `Context: ${JSON.stringify(ctx)}
Recent chat:
${recentChat(trip)}

NEW message from ${sender?.name} (id ${senderId}${senderId === trip.organizerId ? ", organizer" : ""}):
"""${text}"""`,
  })).object);
  return object;
}

export const LockedReply = z.object({
  respond: z.boolean().describe("false for casual banter that needs no assistant reply"),
  reply: z.string().describe("Short answer for the group (Hinglish ok). Use only facts from the context; never invent payment states."),
  wantsRecovery: z
    .boolean()
    .describe("true if someone says they can't/won't pay, wants to drop out, offers to cover someone, wants to extend or cancel, or explicitly asks for the agent / recovery options."),
});
export type LockedReply = z.infer<typeof LockedReply>;

/** Answer once the plan is locked (no plan changes); flags when the commitment agent should step in. */
export async function answerLocked(trip: Trip, senderId: string, text: string): Promise<LockedReply> {
  const sender = trip.members.find((m) => m.userId === senderId);
  const { result } = await withModel(async (m) => (await generateObject({
    model: m,
    schema: LockedReply,
    system: `You are TripMate, the assistant in a group-trip chat. The plan is LOCKED because GroupCommit has started; you cannot change shares from chat.
Answer briefly using the context (Hinglish is fine): who has committed (AUTHORIZED = on hold), who is pending (CREATED = not committed yet), how much is still missing.
If someone can't pay or wants changes, set wantsRecovery=true: the commitment agent will verify with PayPal and post options for the group to approve.`,
    prompt: `Context: ${JSON.stringify(tripContext(trip))}
Recent chat:
${recentChat(trip)}

NEW message from ${sender?.name}: """${text}"""`,
  })).object);
  return result;
}

/** Offline fallback when no API key: understands "<n> nights/raat" for the sender only. */
export function fallbackInterpret(text: string, senderId: string): ChatExtraction {
  const m = text.match(/(\d+)\s*(nights?|raat|din|days?)/i);
  const aboutMe = /\b(i|i'll|i'm|me|my|main|mai|mera|meri|mujhe)\b/i.test(text);
  const addressed = /tripmate|@ai|\?/i.test(text);
  return {
    respond: Boolean((m && aboutMe) || addressed),
    reply: m && aboutMe ? "Noted (AI offline, simple parser)." : "AI is offline right now, so I can only understand \"I'm staying N nights\". Use the plan panel for other changes.",
    nights: m && aboutMe ? [{ memberId: senderId, nights: Number(m[1]) }] : [],
    surcharges: [],
    expenses: [],
    askConfirm: [],
  };
}
