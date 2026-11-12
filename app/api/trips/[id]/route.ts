import { handle, type RouteCtx } from "@/lib/api";
import { HttpError, readStore } from "@/lib/store";
import { requireUser } from "@/lib/auth";
import { getTripOr404, tripView } from "@/lib/trips";
import { autopilotSoon } from "@/lib/autopilot";

export const dynamic = "force-dynamic";

// Full trip state for members (polled by the trip page).
export const GET = handle(async (req: Request, ctx: RouteCtx) => {
  const me = await requireUser(req);
  const { id } = await ctx.params;
  const trip = getTripOr404(await readStore(), id);
  if (!trip.members.some((m) => m.userId === me.id)) {
    throw new HttpError(403, "You're not in this group yet. Ask a member for the invite link.");
  }
  autopilotSoon(id); // agent checks deadlines in the background (throttled)
  return { trip: tripView(trip) };
});
