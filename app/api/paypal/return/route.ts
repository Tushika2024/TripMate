// PayPal redirects the payer here after approval: ?token=<ORDER_ID>&PayerID=...
// We place the hold (authorize) server-side and verify the result with PayPal.
import { NextResponse } from "next/server";
import { getAppUrl } from "@/lib/paypal";
import { authorizeIfNeeded } from "@/lib/commit";

export async function GET(req: Request) {
  const base = getAppUrl(req);
  const orderId = new URL(req.url).searchParams.get("token");
  if (!orderId) return NextResponse.redirect(`${base}/?error=missing_token`);

  const r = await authorizeIfNeeded(orderId);
  if (!r.found) return NextResponse.redirect(`${base}/?error=unknown_order`);

  const q = r.ok ? `committed=${encodeURIComponent(r.c.memberId)}` : `error=${encodeURIComponent(r.c.lastError ?? "authorization_failed")}`;
  return NextResponse.redirect(`${base}/t/${r.trip.id}?${q}`);
}
