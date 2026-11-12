import { handle, type RouteCtx } from "@/lib/api";
import { updateStore } from "@/lib/store";
import { requireUser } from "@/lib/auth";
import { getTripOr404, joinTrip, tripView } from "@/lib/trips";

export const POST = handle(async (req: Request, ctx: RouteCtx) => {
  const me = await requireUser(req);
  const { id } = await ctx.params;
  const trip = await updateStore((s) => {
    const t = getTripOr404(s, id);
    joinTrip(s, t, me);
    return t;
  });
  return { trip: tripView(trip) };
});
