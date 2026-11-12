// GroupCommit actions:
//  start     -> one PayPal AUTHORIZE order per share (organizer, all approved)
//  finalize  -> capture every authorization (organizer, fully committed)
//  void      -> release every hold (organizer)
//  refresh   -> re-check one order with PayPal (any member)
//  confirm   -> organizer marks the hostel booking confirmed (FUNDED -> CONFIRMED)
//  demo_deadline -> demo helper: move the deadline to 30 minutes from now
import { z } from "zod";
import { body, handle, type RouteCtx } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { addSystemMessage, addTimeline, HttpError, memberName, updateStore } from "@/lib/store";
import { finalizeCommit, refreshCommitment, startCommit, voidAll } from "@/lib/commit";
import { getAppUrl } from "@/lib/paypal";
import { getTripOr404, requireOrganizer, tripView } from "@/lib/trips";
import { autopilotTick } from "@/lib/autopilot";
import { readStore } from "@/lib/store";

export const maxDuration = 60;

const Action = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start") }),
  z.object({ action: z.literal("finalize") }),
  z.object({ action: z.literal("void") }),
  z.object({ action: z.literal("refresh"), orderId: z.string().min(5) }),
  z.object({ action: z.literal("confirm") }),
  z.object({ action: z.literal("demo_deadline") }),
]);

export const POST = handle(async (req: Request, ctx: RouteCtx) => {
  const me = await requireUser(req);
  const { id } = await ctx.params;
  const b = { ...(await body(req, Action)), userId: me.id };

  switch (b.action) {
    case "start":
      return { trip: tripView(await startCommit(id, b.userId, getAppUrl(req))) };
    case "finalize":
      return { trip: tripView(await finalizeCommit(id, b.userId)) };
    case "void":
      return { trip: tripView(await voidAll(id, b.userId)) };
    case "refresh":
      return { trip: tripView(await refreshCommitment(id, b.userId, b.orderId)) };
    case "confirm": {
      const trip = await updateStore((s) => {
        const t = getTripOr404(s, id);
        requireOrganizer(t, b.userId);
        if (t.status !== "FUNDED") throw new HttpError(409, "Only a FUNDED booking can be marked confirmed");
        t.status = "CONFIRMED";
        addSystemMessage(t, `🏨 ${memberName(t, b.userId)} marked the booking with ${t.merchant} as confirmed.`);
        addTimeline(t, "user", "Booking confirmed with merchant");
        return t;
      });
      return { trip: tripView(trip) };
    }
    case "demo_deadline": {
      const trip = await updateStore((s) => {
        const t = getTripOr404(s, id);
        requireOrganizer(t, b.userId);
        t.deadline = new Date(Date.now() + 30 * 60_000).toISOString();
        addTimeline(t, "system", "Demo: deadline moved to 30 minutes from now");
        return t;
      });
      // The autopilot notices the deadline is near and runs the agent on its own.
      await autopilotTick(id);
      return { trip: tripView(getTripOr404(await readStore(), id)) };
    }
  }
});
