"use client";
// Browser-side helpers: session (JWT lives in an httpOnly cookie, never in JS) + API calls.
import { useCallback, useEffect, useState } from "react";

export interface Identity {
  id: string;
  name: string;
  email: string | null;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T = any>(url: string, payload?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: payload === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    cache: "no-store",
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || `Request failed (${res.status})`);
  return data as T;
}

/** Current logged-in user (from the server, via the JWT cookie). */
export function useAuth() {
  const [me, setMe] = useState<Identity | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    api<{ user: Identity | null }>("/api/auth/me")
      .then((d) => setMe(d.user))
      .catch(() => setMe(null))
      .finally(() => setReady(true));
  }, []);

  const logout = useCallback(async () => {
    await api("/api/auth/logout", {}).catch(() => undefined);
    setMe(null);
    window.location.href = "/login";
  }, []);

  return { me, ready, logout };
}

/** Send the user to the login page and bring them back here afterwards. */
export function goToLogin(next?: string) {
  const target = next ?? window.location.pathname + window.location.search;
  window.location.href = `/login?next=${encodeURIComponent(target)}`;
}
