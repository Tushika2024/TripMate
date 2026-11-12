// Email + password auth with a JWT (HS256) in an httpOnly cookie.
// No extra dependencies: Node's crypto does scrypt hashing and HMAC signing.
import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from "crypto";
import { promisify } from "util";
import { cookies } from "next/headers";
import { HttpError, readStore, type Store, type User } from "./store";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export const SESSION_COOKIE = "tm_session";
const SESSION_DAYS = 7;

function secret(): string {
  const s = process.env.JWT_SECRET;
  if (s && s.length >= 16) return s;
  if (process.env.NODE_ENV === "production") throw new HttpError(500, "JWT_SECRET is not set on the server");
  return "dev-only-insecure-secret-change-me";
}

// ---------------- passwords ----------------

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(pw: string, stored: string | undefined): Promise<boolean> {
  if (!stored) return false;
  const [algo, saltB64, hashB64] = stored.split("$");
  if (algo !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const actual = await scrypt(pw, Buffer.from(saltB64, "base64"), expected.length);
  return timingSafeEqual(expected, actual);
}

// ---------------- JWT (HS256) ----------------

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export function signJwt(payload: Record<string, unknown>, ttlSeconds = SESSION_DAYS * 86400): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ ...payload, iat: now, exp: now + ttlSeconds }));
  const sig = createHmac("sha256", secret()).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

export function verifyJwt(token: string): { sub: string; email: string } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = createHmac("sha256", secret()).update(`${header}.${body}`).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const h = JSON.parse(Buffer.from(header, "base64url").toString());
    if (h.alg !== "HS256") return null;
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    if (typeof p.exp !== "number" || p.exp < Math.floor(Date.now() / 1000)) return null;
    if (typeof p.sub !== "string") return null;
    return { sub: p.sub, email: p.email };
  } catch {
    return null;
  }
}

// ---------------- session helpers ----------------

export async function setSession(user: User) {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, signJwt({ sub: user.id, email: user.email }), {
    httpOnly: true,
    sameSite: "lax", // lax so the cookie survives the redirect back from PayPal
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_DAYS * 86400,
  });
}

export async function clearSession() {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
}

/** Reads the JWT from the cookie (or an Authorization: Bearer header). */
async function tokenFrom(req?: Request): Promise<string | null> {
  const auth = req?.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  const jar = await cookies();
  return jar.get(SESSION_COOKIE)?.value ?? null;
}

export function publicUser(u: User) {
  return { id: u.id, name: u.name, email: u.email ?? null };
}

export async function currentUser(req?: Request, store?: Store): Promise<User | null> {
  const token = await tokenFrom(req);
  if (!token) return null;
  const claims = verifyJwt(token);
  if (!claims) return null;
  const s = store ?? (await readStore());
  return s.users.find((u) => u.id === claims.sub) ?? null;
}

/** Throws 401 unless the request carries a valid session. */
export async function requireUser(req?: Request): Promise<User> {
  const u = await currentUser(req);
  if (!u) throw new HttpError(401, "Please log in first");
  return u;
}

export function normalizeEmail(e: string) {
  return e.trim().toLowerCase();
}
