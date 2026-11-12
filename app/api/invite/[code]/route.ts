// WhatsApp-style invite link: /join/<code>
//  GET  -> public preview of the group (no money details beyond the total)
//  POST -> logged-in user joins the group
import { handle } from "@/lib/api";
import { HttpError, readStore, updateStore } from "@/lib/store";
import { currentUser, requireUser } from "@/lib/auth";
import { findTripByCode, joinTrip } from "@/lib/trips";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ code: string }> };

export const GET = handle(async (req: Request, ctx: Ctx) => {
  const { code } = await ctx.params;
  const store = await readStore();
  const t = findTripByCode(store, code);
  if (!t) throw new HttpError(404, "This invite link is invalid or was reset by the organizer.");
  const me = await currentUser(req, store);
  const isMember = !!me && t.members.some((m) => m.userId === me.id);
  return {
    invite: {
      name: t.name,
      merchant: t.merchant,
      totalCents: t.totalCents,
      currency: t.currency,
      deadline: t.deadline,
      organizer: t.members.find((m) => m.userId === t.organizerId)?.name ?? "Organizer",
      members: t.members.filter((m) => m.status === "ACTIVE").map((m) => m.name),
      closed: t.plan.locked,
      status: t.status,
      isMember,
      tripId: isMember ? t.id : null,
    },
  };
});

export const POST = handle(async (req: Request, ctx: Ctx) => {
  const me = await requireUser(req);
  const { code } = await ctx.params;
  const tripId = await updateStore((s) => {
    const t = findTripByCode(s, code);
    if (!t) throw new HttpError(404, "This invite link is invalid or was reset by the organizer.");
    joinTrip(s, t, me);
    return t.id;
  });
  return { tripId };
});
