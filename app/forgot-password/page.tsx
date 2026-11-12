"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/client";

function ForgotForm() {
  const params = useSearchParams();
  const [email, setEmail] = useState(params.get("email") ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ message: string; demoLink?: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setDone(await api<{ message: string; demoLink?: string }>("/api/auth/forgot", { email }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto mt-8 max-w-md rounded-[2.25rem] bg-paper p-8 shadow-sm ring-1 ring-sand">
      <p className="font-script text-5xl text-clay">Forgot?</p>
      <h1 className="font-display mt-1 text-2xl text-ink">Reset your password</h1>
      <p className="mt-1 text-sm text-muted">Enter your account email and we'll send you a link to set a new password.</p>

      {done ? (
        <div className="mt-5 space-y-3">
          <p className="rounded-2xl bg-sage-light px-4 py-3 text-sm text-sage-dark">{done.message}</p>
          {done.demoLink && (
            <div className="rounded-2xl bg-[#f4e6c8] px-4 py-3 text-xs text-[#7a5b1c]">
              <p className="font-medium">Demo mode (no email service configured): here is your link.</p>
              <a href={done.demoLink} className="mt-1 block break-all text-clay underline">
                {done.demoLink}
              </a>
            </div>
          )}
        </div>
      ) : (
        <form onSubmit={submit} className="mt-5 space-y-3">
          <input
            required
            type="email"
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className="block w-full rounded-full bg-white px-4 py-2 text-sm ring-1 ring-sand focus:outline-none focus:ring-2 focus:ring-sage"
          />
          {error && <p className="rounded-2xl bg-[#f3dccf] px-4 py-2 text-sm text-[#9a4f35]">{error}</p>}
          <button disabled={busy} className="w-full rounded-full bg-sage-dark px-4 py-2.5 text-sm font-medium text-white hover:bg-ink disabled:opacity-50">
            {busy ? "Sending…" : "Send reset link"}
          </button>
        </form>
      )}
      <Link href="/login" className="mt-5 inline-block text-xs text-clay hover:underline">
        ← Back to log in
      </Link>
    </div>
  );
}

export default function ForgotPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ForgotForm />
    </Suspense>
  );
}
