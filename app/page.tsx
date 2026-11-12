"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, goToLogin, useAuth } from "@/lib/client";
import { Avatar, Button, Pill, ScriptTitle, WhoAmI } from "@/components/ui";
import { formatMoney } from "@/lib/money";

interface TripSummary {
  id: string;
  name: string;
  merchant: string;
  status: string;
  totalCents: number;
  currency: string;
  members: number;
  isOrganizer: boolean;
  lastMessage?: string;
}

const WHY = {
  chat: {
    label: "Shared chat",
    title: "One chat, one plan",
    body: "Everyone talks in the same group chat, in English or Hinglish. TripMate's AI turns “main sirf 2 raat rukungi” or “dinner $60 sabka” into one versioned plan. Code does the maths to the cent, and every change needs everyone's approval again.",
    tag: "Stay by nights · food, cabs & activities split fairly",
  },
  commit: {
    label: "GroupCommit",
    title: "Commit together, pay once",
    body: "Each friend puts their share on hold with PayPal. Nobody is charged until the whole group is in. Then the organizer captures every hold at once and the money goes to the merchant PayPal confirms.",
    tag: "PayPal authorize → capture all, or void all",
  },
  agent: {
    label: "AI agent",
    title: "An agent that watches the deadline",
    body: "If someone hasn't committed near the deadline, the agent checks PayPal itself and proposes Cover, Re-split, Extend or Cancel, with exact amounts. Nothing happens until the people affected say yes.",
    tag: "AI recommends · humans approve · PayPal executes",
  },
} as const;

export default function Home() {
  const { me, ready, logout } = useAuth();
  const router = useRouter();
  const [inviteInput, setInviteInput] = useState("");
  const [trips, setTrips] = useState<TripSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<keyof typeof WHY>("chat");
  const [form, setForm] = useState({
    name: "Goa Trip",
    merchant: "Goa Beach Hostel",
    total: "280",
    deadlineHours: "3",
    merchantPaypalEmail: "",
    bookingRef: "",
  });

  const load = useCallback(async () => {
    if (!me) return;
    const data = await api<{ trips: TripSummary[] }>("/api/trips");
    setTrips(data.trips);
  }, [me]);

  useEffect(() => {
    load();
    const q = new URLSearchParams(window.location.search).get("error");
    if (q) setError(q);
  }, [load]);

  useEffect(() => {
    if (ready && !me) goToLogin("/");
  }, [ready, me]);

  if (!ready || !me) return null;

  function openInvite() {
    const v = inviteInput.trim();
    const code = v.match(/\/join\/([A-Za-z0-9]+)/)?.[1] ?? v.replace(/[^A-Za-z0-9]/g, "");
    if (code) router.push(`/join/${code}`);
  }

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const { trip } = await api("/api/trips", form);
      router.push(`/t/${trip.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const active = trips?.filter((t) => !["CONFIRMED", "CANCELLED"].includes(t.status)).length ?? 0;
  const funded = trips?.filter((t) => ["FUNDED", "CONFIRMED"].includes(t.status)).length ?? 0;
  const why = WHY[tab];
  const field = "mt-1 block w-full rounded-full border-0 bg-white/90 px-4 py-2 text-sm text-ink placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-clay/50";

  return (
    <div className="space-y-12">
      {/* Hero */}
      <section className="hero-sky relative overflow-hidden rounded-[2.25rem] px-6 pb-8 pt-6 shadow-sm">
        <div className="flex items-center justify-between">
          <p className="text-xs uppercase tracking-[0.25em] text-ink/70">Hi, {me.name.split(" ")[0]}</p>
          <WhoAmI me={me} onLogout={logout} />
        </div>
        <div className="py-10 text-center sm:py-14">
          <p className="font-script text-6xl leading-none text-sage-dark/90 drop-shadow-sm sm:text-8xl">
            Travel <span className="text-clay">&amp;</span> Together
          </p>
          <p className="mx-auto mt-5 max-w-md text-sm text-ink/80">
            Plan the trip in one chat, put your share on hold with PayPal, and pay only when the whole group is ready.
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-3">
          <a href="#create" className="rounded-full bg-ink/85 px-6 py-2.5 text-sm font-medium text-paper shadow hover:bg-ink">
            Plan a new trip
          </a>
          <a href="#invite" className="rounded-full bg-paper/80 px-6 py-2.5 text-sm font-medium text-ink shadow hover:bg-paper">
            I have an invite link
          </a>
        </div>
      </section>

      {error && <div className="rounded-2xl bg-[#f3dccf] px-4 py-2 text-sm text-[#9a4f35]">{error}</div>}

      {/* Stats */}
      <section className="grid grid-cols-3 gap-3">
        {[
          ["Trips", trips?.length ?? "–"],
          ["In progress", active],
          ["Funded", funded],
        ].map(([label, value]) => (
          <div key={label} className="rounded-3xl bg-paper px-4 py-4 text-center ring-1 ring-sand">
            <p className="font-display text-3xl text-ink">{value}</p>
            <p className="text-xs uppercase tracking-widest text-muted">{label}</p>
          </div>
        ))}
      </section>

      {/* My trips */}
      <section className="space-y-5">
        <div className="text-center">
          <ScriptTitle left="Your" right="Trips" className="text-4xl sm:text-5xl" />
          <p className="mt-2 text-sm text-muted">Every group you plan with, in one place.</p>
        </div>
        {trips === null ? (
          <p className="text-center text-sm text-muted">Loading…</p>
        ) : trips.length === 0 ? (
          <div className="rounded-3xl bg-paper p-8 text-center ring-1 ring-sand">
            <p className="font-script text-4xl text-sage">No trips yet</p>
            <p className="mt-2 text-sm text-muted">Create one below, or open an invite link from a friend.</p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {trips.map((t, i) => {
              const sage = i % 3 === 0;
              return (
                <Link
                  key={t.id}
                  href={`/t/${t.id}`}
                  className={`group flex flex-col justify-between rounded-3xl p-5 shadow-sm ring-1 transition hover:-translate-y-0.5 hover:shadow-md ${sage ? "bg-sage text-white ring-sage-dark/20" : "bg-paper ring-sand"}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-3">
                      <Avatar name={t.name} size={40} />
                      <div>
                        <p className="font-display text-xl leading-tight">{t.name}</p>
                        <p className={`text-xs ${sage ? "text-white/75" : "text-muted"}`}>{t.merchant}</p>
                      </div>
                    </div>
                    <Pill value={t.status} raw />
                  </div>
                  {t.lastMessage && (
                    <p className={`mt-4 line-clamp-2 text-sm ${sage ? "text-white/85" : "text-ink/75"}`}>“{t.lastMessage}”</p>
                  )}
                  <div className={`mt-5 flex items-center justify-between border-t pt-3 text-xs ${sage ? "border-white/20 text-white/80" : "border-sand text-muted"}`}>
                    <span>
                      {formatMoney(t.totalCents, t.currency)} · {t.members} member{t.members === 1 ? "" : "s"}
                      {t.isOrganizer && " · organizer"}
                    </span>
                    <span className="transition group-hover:translate-x-1">Open chat →</span>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </section>

      {/* Why TripMate */}
      <section className="space-y-5">
        <div className="text-center">
          <ScriptTitle left="Why TripMate" right="not just a split app" className="text-3xl sm:text-4xl" />
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          {(Object.keys(WHY) as (keyof typeof WHY)[]).map((k) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`rounded-xl px-6 py-2 text-sm transition ${tab === k ? "bg-sage text-white" : "text-ink ring-1 ring-sage/40 hover:bg-sage-light/60"}`}
            >
              {WHY[k].label}
            </button>
          ))}
        </div>
        <div className="grid items-center gap-6 rounded-[2rem] bg-sage p-6 text-white sm:grid-cols-2 sm:p-8">
          <div>
            <h3 className="font-display text-2xl">{why.title}</h3>
            <p className="mt-3 text-sm leading-relaxed text-white/85">{why.body}</p>
            <p className="mt-5 text-xs uppercase tracking-widest text-white/60">{why.tag}</p>
          </div>
          <div className="hero-sky flex h-48 items-center justify-center rounded-3xl">
            <p className="font-script text-5xl text-paper drop-shadow">{why.label}</p>
          </div>
        </div>
      </section>

      {/* Create + invite */}
      <section className="grid gap-4 lg:grid-cols-5">
        <div id="create" className="rounded-[2rem] bg-sage p-6 text-white shadow-sm lg:col-span-3">
          <h3 className="font-display text-2xl">Plan a new trip</h3>
          <p className="mt-1 text-sm text-white/75">The booking you're splitting. Food, cabs and activities can be added later in the chat.</p>
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            {(
              [
                ["name", "Trip name", "Goa Trip"],
                ["merchant", "Hotel / hostel (merchant)", "Goa Beach Hostel"],
                ["total", "Stay total (USD)", "280"],
                ["deadlineHours", "Commit deadline (hours)", "3"],
                ["merchantPaypalEmail", "Merchant's PayPal email (optional)", "hostel@business.example.com"],
                ["bookingRef", "Booking reference (optional)", "GOA-1234"],
              ] as const
            ).map(([k, label, ph]) => (
              <label key={k} className="text-xs uppercase tracking-wider text-white/80">
                {label}
                <input value={form[k]} placeholder={ph} onChange={(e) => setForm({ ...form, [k]: e.target.value })} className={field} />
              </label>
            ))}
          </div>
          <div className="mt-5">
            <Button kind="light" onClick={create} disabled={busy}>
              {busy ? "Creating…" : "Create trip →"}
            </Button>
          </div>
        </div>

        <div id="invite" className="flex flex-col justify-between rounded-[2rem] bg-paper p-6 ring-1 ring-sand lg:col-span-2">
          <div>
            <p className="font-script text-4xl text-clay">Got an invite?</p>
            <p className="mt-2 text-sm text-muted">Paste the link a friend sent you (…/join/ABCD234XYZ) or just the code.</p>
          </div>
          <form
            className="mt-5 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              openInvite();
            }}
          >
            <input
              value={inviteInput}
              onChange={(e) => setInviteInput(e.target.value)}
              placeholder="Invite link or code"
              className="block w-full rounded-full bg-white px-4 py-2 text-sm ring-1 ring-sand focus:outline-none focus:ring-2 focus:ring-sage"
            />
            <Button type="submit" disabled={!inviteInput.trim()}>
              Open invite
            </Button>
          </form>
        </div>
      </section>
    </div>
  );
}
