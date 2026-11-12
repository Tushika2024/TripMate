// Organizer resets the invite link (old link stops working), like WhatsApp "Reset link".
import { handle, type RouteCtx } from "@/lib/api";
import { addTimeline, updateStore } from "@/lib/store";
import { requireUser } from "@/lib/auth";
import { getTripOr404, newInviteCode, requireOrganizer, tripView } from "@/lib/trips";

export const POST = handle(async (req: Request, ctx: RouteCtx) => {
  const me = await requireUser(req);
  const { id } = await ctx.params;
  const trip = await updateStore((s) => {
    const t = getTripOr404(s, id);
    requireOrganizer(t, me.id);
    t.joinCode = newInviteCode(s);
    addTimeline(t, "user", `${me.name} reset the invite link`);
    return t;
  });
  return { trip: tripView(trip) };
});
