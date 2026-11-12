import { NextResponse } from "next/server";
import { handleEvent, verifySignature, type WebhookEvent } from "@/lib/webhooks";

export async function POST(req: Request) {
  const raw = await req.text();
  let event: WebhookEvent;
  try {
    event = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  let verified = false;
  try {
    verified = await verifySignature(req.headers, event);
  } catch (e) {
    console.error("[webhook] verification error", e);
  }
  if (!verified) {
    console.warn(`[webhook] rejected ${event.event_type} ${event.id}: signature not verified (is PAYPAL_WEBHOOK_ID set?)`);
    return NextResponse.json({ error: "signature verification failed" }, { status: 400 });
  }

  try {
    const result = await handleEvent(event);
    return NextResponse.json({ ok: true, result });
  } catch (e) {
    console.error("[webhook] handler error", e);
    // 500 makes PayPal retry later.
    return NextResponse.json({ error: "handler error" }, { status: 500 });
  }
}
