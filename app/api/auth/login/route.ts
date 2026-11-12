import { z } from "zod";
import { body, handle } from "@/lib/api";
import { HttpError, readStore } from "@/lib/store";
import { normalizeEmail, publicUser, setSession, verifyPassword } from "@/lib/auth";

const Login = z.object({ email: z.string().trim().min(3), password: z.string().min(1).max(100) });

export const POST = handle(async (req: Request) => {
  const b = await body(req, Login);
  const store = await readStore();
  const user = store.users.find((u) => u.email === normalizeEmail(b.email));
  if (!user || !(await verifyPassword(b.password, user.passwordHash))) {
    throw new HttpError(401, "Wrong email or password");
  }
  await setSession(user);
  return { user: publicUser(user) };
});
