"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { api } from "@/lib/client";

function safeNext(n: string | null) {
  return n && n.startsWith("/") && !n.startsWith("//") ? n : "/";
}

function LoginForm() {
  const params = useSearchParams();
  const next = safeNext(params.get("next"));
  const [mode, setMode] = useState<"login" | "signup">(params.get("mode") === "signup" ? "signup" : "login");
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const invited = next.startsWith("/join/");

  // Already logged in? Skip straight to where they were going.
  useEffect(() => {
    api<{ user: unknown }>("/api/auth/me").then((d) => d.user && window.location.replace(next)).catch(() => undefined);
  }, [next]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/api/auth/${mode}`, mode === "signup" ? form : { email: form.email, password: form.password });
      window.location.replace(next);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const input = "mt-1 block w-full rounded-full bg-white px-4 py-2 text-sm ring-1 ring-sand focus:outline-none focus:ring-2 focus:ring-sage";

  return (
    <div className="mx-auto mt-4 grid max-w-4xl overflow-hidden rounded-[2.25rem] bg-paper shadow-sm ring-1 ring-sand md:grid-cols-2">
      <div className="hero-sky hidden flex-col justify-between p-8 md:flex">
        <p className="text-xs uppercase tracking-[0.25em] text-ink/70">TripMate</p>
        <div>
          <p className="font-script text-7xl leading-none text-sage-dark/90">Travel</p>
          <p className="font-script -mt-2 pl-10 text-6xl text-clay">&amp; together</p>
        </div>
        <p className="text-sm text-ink/80">Plan in one chat. Commit with PayPal. Pay only when the group is ready.</p>
      </div>

      <div className="p-6 sm:p-8">
        <h1 className="font-display text-3xl text-ink">{mode === "login" ? "Welcome back" : "Create your account"}</h1>
        <p className="mt-1 text-sm text-muted">
          {invited ? "You were invited to a group. Log in or sign up to join it." : "Plan group trips together, pay only when everyone's in."}
        </p>

        <div className="mt-5 grid grid-cols-2 gap-2">
          {(["login", "signup"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => { setMode(m); setError(null); }}
              className={`rounded-xl px-3 py-2 text-sm ${mode === m ? "bg-sage text-white" : "text-ink ring-1 ring-sage/40"}`}
            >
              {m === "login" ? "Log in" : "Sign up"}
            </button>
          ))}
        </div>

        <form onSubmit={submit} className="mt-5 space-y-3">
          {mode === "signup" && (
            <label className="block text-xs uppercase tracking-wider text-muted">
              Your name
              <input required autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={input} placeholder="What friends call you" />
            </label>
          )}
          <label className="block text-xs uppercase tracking-wider text-muted">
            Email
            <input required type="email" autoComplete="email" autoFocus={mode === "login"} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className={input} placeholder="you@example.com" />
          </label>
          <label className="block text-xs uppercase tracking-wider text-muted">
            Password
            <input
              required
              type="password"
              minLength={mode === "signup" ? 6 : 1}
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              className={input}
              placeholder={mode === "signup" ? "At least 6 characters" : ""}
            />
          </label>
          {mode === "login" && (
            <div className="text-right">
              <a href={`/forgot-password${form.email ? `?email=${encodeURIComponent(form.email)}` : ""}`} className="text-xs text-clay hover:underline">
                Forgot password?
              </a>
            </div>
          )}
          {error && <p className="rounded-2xl bg-[#f3dccf] px-4 py-2 text-sm text-[#9a4f35]">{error}</p>}
          <button disabled={busy} className="w-full rounded-full bg-sage-dark px-4 py-2.5 text-sm font-medium text-white hover:bg-ink disabled:opacity-50">
            {busy ? "Please wait…" : mode === "login" ? "Log in" : "Create account"}
          </button>
        </form>
        <p className="mt-4 text-center text-xs text-muted">Demo tip: use a private window to log in as a second friend.</p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
