import { handle } from "@/lib/api";
import { currentUser, publicUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export const GET = handle(async (req: Request) => {
  const u = await currentUser(req);
  return { user: u ? publicUser(u) : null };
});
