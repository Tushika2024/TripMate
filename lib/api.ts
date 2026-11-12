import { NextResponse } from "next/server";
import { z } from "zod";
import { HttpError } from "./store";

export type RouteCtx = { params: Promise<{ id: string }> };

/** Wrap a route handler: turns HttpError / zod errors into JSON responses. */
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<unknown>) {
  return async (...args: A) => {
    try {
      const out = await fn(...args);
      return out instanceof Response ? out : NextResponse.json(out);
    } catch (e) {
      if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
      if (e instanceof z.ZodError) {
        return NextResponse.json({ error: e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, { status: 400 });
      }
      console.error(e);
      return NextResponse.json({ error: e instanceof Error ? e.message : "Server error" }, { status: 500 });
    }
  };
}

export async function body<T extends z.ZodTypeAny>(req: Request, schema: T): Promise<z.infer<T>> {
  const json = await req.json().catch(() => ({}));
  return schema.parse(json);
}

export const UserId = z.string().min(3).max(40);
