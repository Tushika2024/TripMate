// Run the commitment agent, or vote on one of its recovery options.
import { z } from "zod";
import { body, handle, type RouteCtx } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { runAgent, vote } from "@/lib/agent";
import { getAppUrl } from "@/lib/paypal";
import { tripView } from "@/lib/trips";

export const maxDuration = 60;

const Action = z.discriminatedUnion("action", [
  z.object({ action: z.literal("run"), trigger: z.string().max(60).default("MANUAL") }),
  z.object({
    action: z.literal("vote"),
    proposalId: z.string(),
    option: z.enum(["COVER", "RESPLIT", "EXTEND", "CANCEL"]),
    decision: z.enum(["YES", "NO"]),
  }),
]);

export const POST = handle(async (req: Request, ctx: RouteCtx) => {
  const me = await requireUser(req);
  const { id } = await ctx.params;
  const b = await body(req, Action);
  if (b.action === "run") return { trip: tripView(await runAgent(id, me.id, b.trigger)) };
  return { trip: tripView(await vote(id, b.proposalId, b.option, me.id, b.decision, getAppUrl(req))) };
});
