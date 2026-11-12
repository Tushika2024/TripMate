"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/client";

function ResetForm() {
  const token = useSearchParams().get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) return setError("Passwords don't match");
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/reset", { token, password });
      window.location.replace("/");
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const input = "block w-full rounded-full bg-white px-4 py-2 text-sm ring-1 ring-sand focus:outline-none focus:ring-2 focus:ring-sage";

  return (
    <div className="mx-auto mt-8 max-w-md rounded-[2.25rem] bg-paper p-8 shadow-sm ring-1 ring-sand">
      <p className="font-script text-5xl text-clay">Fresh start</p>
      <h1 className="font-display mt-1 text-2xl text-ink">Choose a new password</h1>
      {!token ? (
        <p className="mt-4 text-sm text-muted">This link is missing its token. Ask for a new reset link.</p>
      ) : (
        <form onSubmit={submit} className="mt-5 space-y-3">
          <input required type="password" minLength={6} autoComplete="new-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} placeholder="New password (6+ characters)" className={input} />
          <input required type="password" minLength={6} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Repeat new password" className={input} />
          {error && <p className="rounded-2xl bg-[#f3dccf] px-4 py-2 text-sm text-[#9a4f35]">{error}</p>}
          <button disabled={busy} className="w-full rounded-full bg-sage-dark px-4 py-2.5 text-sm font-medium text-white hover:bg-ink disabled:opacity-50">
            {busy ? "Saving…" : "Save password and log in"}
          </button>
        </form>
      )}
      <Link href="/forgot-password" className="mt-5 inline-block text-xs text-clay hover:underline">
        Need a new link?
      </Link>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetForm />
    </Suspense>
  );
}
