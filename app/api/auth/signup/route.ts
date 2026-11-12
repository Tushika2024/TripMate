import { z } from "zod";
import { body, handle } from "@/lib/api";
import { HttpError, nowIso, updateStore } from "@/lib/store";
import { hashPassword, normalizeEmail, publicUser, setSession } from "@/lib/auth";

const Signup = z.object({
  name: z.string().trim().min(1, "Name is required").max(40),
  email: z.string().trim().email("Enter a valid email"),
  password: z.string().min(6, "Password must be at least 6 characters").max(100),
});

export const POST = handle(async (req: Request) => {
  const b = await body(req, Signup);
  const email = normalizeEmail(b.email);
  const passwordHash = await hashPassword(b.password); // hash outside the store lock
  const user = await updateStore((s) => {
    if (s.users.some((u) => u.email === email)) throw new HttpError(409, "An account with this email already exists. Log in instead.");
    const u = { id: `u_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`, name: b.name, email, passwordHash, createdAt: nowIso() };
    s.users.push(u);
    return u;
  });
  await setSession(user);
  return { user: publicUser(user) };
});
