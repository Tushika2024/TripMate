// Reset password with the one-time token from the reset link, then log the user in.
import { createHash, timingSafeEqual } from "crypto";
import { z } from "zod";
import { body, handle } from "@/lib/api";
import { HttpError, updateStore } from "@/lib/store";
import { hashPassword, publicUser, setSession } from "@/lib/auth";

const Reset = z.object({
  token: z.string().min(20).max(200),
  password: z.string().min(6, "Password must be at least 6 characters").max(100),
});

export const POST = handle(async (req: Request) => {
  const b = await body(req, Reset);
  const hash = Buffer.from(createHash("sha256").update(b.token).digest("hex"));
  const passwordHash = await hashPassword(b.password);
  const user = await updateStore((s) => {
    const u = s.users.find((x) => {
      if (!x.resetTokenHash) return false;
      const stored = Buffer.from(x.resetTokenHash);
      return stored.length === hash.length && timingSafeEqual(stored, hash);
    });
    if (!u || !u.resetTokenExpiresAt || Date.parse(u.resetTokenExpiresAt) < Date.now()) {
      throw new HttpError(400, "This reset link is invalid or has expired. Ask for a new one.");
    }
    u.passwordHash = passwordHash;
    u.resetTokenHash = null; // one-time use
    u.resetTokenExpiresAt = null;
    return u;
  });
  await setSession(user);
  return { user: publicUser(user) };
});
