import { z } from "zod";
import { body, handle } from "@/lib/api";
import { readStore, updateStore } from "@/lib/store";
import { requireUser } from "@/lib/auth";
import { createTrip, tripView } from "@/lib/trips";
import { toCents } from "@/lib/money";

export const dynamic = "force-dynamic";

// List the trips the logged-in user belongs to.
export const GET = handle(async (req: Request) => {
  const me = await requireUser(req);
  const store = await readStore();
  const trips = store.trips
    .filter((t) => t.members.some((m) => m.userId === me.id))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((t) => ({
      id: t.id,
      name: t.name,
      merchant: t.merchant,
      status: t.status,
      totalCents: t.totalCents,
      currency: t.currency,
      members: t.members.length,
      isOrganizer: t.organizerId === me.id,
      lastMessage: t.messages.at(-1)?.text.slice(0, 80) ?? "",
    }));
  return { trips };
});

const CreateTrip = z.object({
  name: z.string().min(1).max(60),
  merchant: z.string().min(1).max(60),
  total: z.coerce.number().positive().max(10000),
  deadlineHours: z.coerce.number().min(0.25).max(72).default(3),
  merchantPaypalEmail: z.union([z.string().trim().email("Merchant PayPal email looks wrong"), z.literal("")]).optional(),
  bookingRef: z.string().trim().max(60).optional(),
  address: z.string().trim().max(120).optional(),
});

export const POST = handle(async (req: Request) => {
  const me = await requireUser(req);
  const b = await body(req, CreateTrip);
  const trip = await updateStore((s) =>
    createTrip(s, {
      user: me,
      name: b.name,
      merchant: b.merchant,
      totalCents: toCents(b.total),
      deadlineHours: b.deadlineHours,
      merchantInfo: {
        paypalEmail: b.merchantPaypalEmail?.toLowerCase() || undefined,
        bookingRef: b.bookingRef || undefined,
        address: b.address || undefined,
      },
    }),
  );
  return { trip: tripView(trip) };
});
