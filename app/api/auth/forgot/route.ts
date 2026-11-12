// Forgot password: create a one-time reset link (valid 30 min). Only its SHA-256 hash is stored.
// Delivery: email via Resend (if RESEND_API_KEY is set); otherwise, in local/demo mode,
// the link is shown on screen so the flow can be demoed without an email provider.
import { createHash, randomBytes } from "crypto";
import { z } from "zod";
import { body, handle } from "@/lib/api";
import { updateStore } from "@/lib/store";
import { normalizeEmail } from "@/lib/auth";
import { getAppUrl } from "@/lib/paypal";

const Forgot = z.object({ email: z.string().trim().email("Enter a valid email") });
const TTL_MS = 30 * 60_000;

async function sendEmail(to: string, link: string): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return false;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.RESEND_FROM || "TripMate <onboarding@resend.dev>",
      to,
      subject: "Reset your TripMate password",
      html: `<p>Someone asked to reset your TripMate password.</p><p><a href="${link}">Reset password</a> (valid for 30 minutes)</p><p>If this wasn't you, ignore this email.</p>`,
    }),
  }).catch(() => null);
  if (!res?.ok) console.error("[auth] reset email failed:", res?.status);
  return !!res?.ok;
}

export const POST = handle(async (req: Request) => {
  const { email } = await body(req, Forgot);
  const token = randomBytes(32).toString("base64url");
  const found = await updateStore((s) => {
    const u = s.users.find((x) => x.email === normalizeEmail(email));
    if (!u) return false;
    u.resetTokenHash = createHash("sha256").update(token).digest("hex");
    u.resetTokenExpiresAt = new Date(Date.now() + TTL_MS).toISOString();
    return true;
  });

  const generic = { ok: true, message: "If an account exists for this email, a reset link has been sent." };
  if (!found) return generic; // don't reveal which emails are registered

  const link = `${getAppUrl(req)}/reset-password?token=${token}`;
  if (await sendEmail(normalizeEmail(email), link)) return generic;

  const demo = process.env.NODE_ENV !== "production" || process.env.DEMO_SHOW_RESET_LINK === "true";
  console.log(`[auth] password reset link for ${normalizeEmail(email)}: ${link}`);
  return demo ? { ...generic, demoLink: link } : generic;
});
