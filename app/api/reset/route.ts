// Demo helper: wipe all local data (does not touch PayPal). Disabled in production.
import { NextResponse } from "next/server";
import { emptyStore, updateStore } from "@/lib/store";

export async function POST() {
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_RESET !== "true") {
    return NextResponse.json({ error: "Reset is disabled in production" }, { status: 403 });
  }
  await updateStore((s) => {
    Object.assign(s, emptyStore());
  });
  return NextResponse.json({ ok: true });
}
