import { z } from "zod";
import { body, handle, type RouteCtx } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { postMessage } from "@/lib/chat";
import { tripView } from "@/lib/trips";

export const maxDuration = 60;

const Msg = z.object({ text: z.string().min(1).max(1000) });

// Stores the message right away; TripMate replies in the background ("typing…").
export const POST = handle(async (req: Request, ctx: RouteCtx) => {
  const me = await requireUser(req);
  const { id } = await ctx.params;
  const b = await body(req, Msg);
  const trip = await postMessage(id, me.id, b.text);
  return { trip: tripView(trip) };
});
