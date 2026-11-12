// Manual plan edits (Phase 3 adds the AI chat that produces the same edits):
//  - nights: a member sets their OWN nights (self-statements are authoritative)
//  - surcharge: organizer adds/removes an extra for a member (amount 0 removes)
//  - approve: a member approves their share for the current plan version
import { z } from "zod";
import { body, handle, type RouteCtx } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { addSystemMessage, addTimeline, HttpError, memberName, randomId, updateStore } from "@/lib/store";
import { getTripOr404, recalcPlan, requireMember, requireOrganizer, tripView } from "@/lib/trips";
import { formatMoney, toCents } from "@/lib/money";

const Action = z.discriminatedUnion("action", [
  z.object({ action: z.literal("nights"), nights: z.coerce.number().int().min(0).max(60) }),
  z.object({
    action: z.literal("surcharge"),
    
    memberId: z.string(),
    amount: z.coerce.number().min(0).max(10000),
    reason: z.string().min(1).max(60),
  }),
  z.object({ action: z.literal("approve"), version: z.coerce.number().int() }),
  z.object({
    action: z.literal("expense_add"),
    title: z.string().trim().min(1).max(40),
    category: z.enum(["food", "transport", "activity", "other"]).default("other"),
    amount: z.coerce.number().positive().max(10000),
    participantIds: z.array(z.string()).max(50).default([]),
  }),
  z.object({ action: z.literal("expense_remove"), expenseId: z.string() }),
]);

export const POST = handle(async (req: Request, ctx: RouteCtx) => {
  const me = await requireUser(req);
  const { id } = await ctx.params;
  const b = { ...(await body(req, Action)), userId: me.id };

  const trip = await updateStore((s) => {
    const t = getTripOr404(s, id);
    const me = requireMember(t, b.userId);
    if (t.plan.locked) throw new HttpError(409, "Plan is locked because GroupCommit has started");

    if (b.action === "nights") {
      me.nights = b.nights;
      const { changed } = recalcPlan(t);
      if (changed) {
        addSystemMessage(t, `${me.name} is staying ${b.nights} night(s). Plan updated to v${t.plan.version}; please re-approve.`);
        addTimeline(t, "user", `${me.name} set nights = ${b.nights}`);
      }
    } else if (b.action === "surcharge") {
      requireOrganizer(t, b.userId);
      requireMember(t, b.memberId);
      t.plan.surcharges = t.plan.surcharges.filter((x) => x.memberId !== b.memberId);
      const cents = toCents(b.amount);
      if (cents > 0) t.plan.surcharges.push({ memberId: b.memberId, cents, reason: b.reason });
      const { changed } = recalcPlan(t);
      if (changed) {
        addSystemMessage(t, `Extra for ${memberName(t, b.memberId)}: ${formatMoney(cents, t.currency)} (${b.reason}). Plan v${t.plan.version}; please re-approve.`);
        addTimeline(t, "user", `${me.name} set surcharge for ${memberName(t, b.memberId)}`);
      }
    } else if (b.action === "expense_add") {
      const ids = b.participantIds.filter((pid) => t.members.some((m) => m.userId === pid && m.status === "ACTIVE"));
      const cents = toCents(b.amount);
      t.plan.expenses = [...(t.plan.expenses ?? []), { id: randomId(8), title: b.title, category: b.category, cents, participantIds: ids, addedBy: me.userId }];
      recalcPlan(t);
      const who = ids.length ? ids.map((x) => memberName(t, x)).join(", ") : "everyone";
      addSystemMessage(t, `🧾 ${me.name} added ${b.title}: ${formatMoney(cents, t.currency)}, split between ${who}. Plan v${t.plan.version}; please re-approve.`);
      addTimeline(t, "user", `${me.name} added expense "${b.title}" (${formatMoney(cents, t.currency)})`);
    } else if (b.action === "expense_remove") {
      const e = (t.plan.expenses ?? []).find((x) => x.id === b.expenseId);
      if (!e) throw new HttpError(404, "Expense not found");
      if (e.addedBy !== me.userId && t.organizerId !== me.userId) throw new HttpError(403, "Only the person who added it or the organizer can remove it");
      t.plan.expenses = (t.plan.expenses ?? []).filter((x) => x.id !== e.id);
      recalcPlan(t);
      addSystemMessage(t, `🗑️ ${me.name} removed ${e.title}. Plan v${t.plan.version}; please re-approve.`);
    } else {
      if (b.version !== t.plan.version) throw new HttpError(409, "The plan changed. Review the new version and approve again.");
      t.plan.approvals[me.userId] = t.plan.version;
      addTimeline(t, "user", `${me.name} approved plan v${t.plan.version}`);
    }
    return t;
  });
  return { trip: tripView(trip) };
});
