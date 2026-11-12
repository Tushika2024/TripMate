import { NextResponse } from "next/server";
import { getAppUrl } from "@/lib/paypal";
import { addTimeline, memberName, updateStore } from "@/lib/store";
import { findCommitment } from "@/lib/commit";

export async function GET(req: Request) {
  const base = getAppUrl(req);
  const orderId = new URL(req.url).searchParams.get("token");
  if (!orderId) return NextResponse.redirect(`${base}/?error=missing_token`);

  const tripId = await updateStore((s) => {
    const f = findCommitment(s, orderId);
    if (!f) return null;
    // Payer backed out; the link stays valid, so the commitment stays CREATED.
    addTimeline(f.trip, "paypal", `${memberName(f.trip, f.c.memberId)} closed PayPal without committing`);
    return f.trip.id;
  });
  return NextResponse.redirect(tripId ? `${base}/t/${tripId}?cancelled=1` : `${base}/?error=unknown_order`);
}
