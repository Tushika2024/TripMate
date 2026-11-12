"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api, ApiError, goToLogin, useAuth } from "@/lib/client";
import { Avatar, Button, Card, Pill, WhoAmI } from "@/components/ui";
import { formatMoney } from "@/lib/money";
import type { Trip } from "@/lib/store";

type TripView = Trip & {
  computed: { committedCents: number; gapCents: number; allApproved: boolean; stayCents: number; expensesCents: number; payeeMatchesMerchant: boolean | null };
};

const CATEGORY_ICON: Record<string, string> = { food: "🍽️", transport: "🚕", activity: "🎟️", other: "🧾" };

function timeLeft(iso: string) {
  const ms = Date.parse(iso) - Date.now();
  if (ms <= 0) return "passed";
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m left` : `${m}m left`;
}

export default function TripPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { me, ready, logout } = useAuth();
  const [trip, setTrip] = useState<TripView | null>(null);
  const [notFound, setNotFound] = useState<string | false>(false);
  const [showInvite, setShowInvite] = useState(false);
  const [pendingMsg, setPendingMsg] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "warn" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [surcharge, setSurcharge] = useState({ memberId: "", amount: "40", reason: "private room" });
  const [draft, setDraft] = useState("");
  const [expense, setExpense] = useState<{ title: string; amount: string; category: string; participantIds: string[] }>({ title: "", amount: "", category: "food", participantIds: [] });
  const chatEnd = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const data = await api<{ trip: TripView }>(`/api/trips/${id}`);
      setTrip(data.trip);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return goToLogin();
      setNotFound((e as Error).message);
    }
  }, [id]);

  // Poll so every member sees the same live state.
  useEffect(() => {
    if (!ready) return;
    if (!me) return goToLogin();
    load();
    const t = setInterval(load, 2500);
    return () => clearInterval(t);
  }, [load, ready, me]);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get("committed")) setNotice({ kind: "ok", text: "🔒 Commitment placed on hold with PayPal. Nothing is charged until the group finalizes." });
    else if (q.get("cancelled")) setNotice({ kind: "warn", text: "You closed PayPal without committing. Your link is still valid." });
    else if (q.get("error")) setNotice({ kind: "err", text: q.get("error")! });
    if (q.toString()) window.history.replaceState({}, "", `/t/${id}`);
  }, [id]);

  const msgCount = trip?.messages.length ?? 0;
  const aiTyping = !!trip?.aiTypingSince && Date.now() - Date.parse(trip.aiTypingSince) < 90_000;
  useEffect(() => {
    chatEnd.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [msgCount, pendingMsg, aiTyping]);

  if (!ready || !me) return null;
  if (notFound)
    return (
      <div className="mx-auto mt-16 max-w-sm rounded-[2rem] bg-paper p-8 text-center ring-1 ring-sand">
        <p className="font-script text-5xl text-clay">Oops</p>
        <p className="mt-2 text-sm text-ink">{notFound}</p>
        <Link href="/" className="mt-4 inline-block text-sm text-clay underline">Back to my trips</Link>
      </div>
    );
  if (!trip) return <p className="py-20 text-center font-script text-4xl text-sage">Loading your trip…</p>;

  const isMember = trip.members.some((m) => m.userId === me.id);
  const isOrganizer = trip.organizerId === me.id;
  const name = (uid: string) => (uid === "ai" ? "🤖 TripMate" : uid === "system" ? "TripMate" : (trip.members.find((m) => m.userId === uid)?.name ?? uid));
  const shareOf = (uid: string) => trip.plan.shares.find((s) => s.memberId === uid);
  const locked = trip.plan.locked;
  const joinUrl = typeof window !== "undefined" ? `${window.location.origin}/join/${trip.joinCode}` : "";
  const inviteText = `Join "${trip.name}" on TripMate: we split ${trip.merchant} (${formatMoney(trip.totalCents, trip.currency)}) and only pay when everyone's in. ${joinUrl}`;
  const pct = Math.min(100, Math.round((trip.computed.committedCents / trip.totalCents) * 100));

  async function act(url: string, payload: Record<string, unknown>, okText?: string) {
    setBusy(true);
    try {
      const data = await api<{ trip: TripView }>(url, payload);
      setTrip(data.trip);
      if (okText) setNotice({ kind: "ok", text: okText });
    } catch (e) {
      setNotice({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }
  const plan = (payload: Record<string, unknown>, ok?: string) => act(`/api/trips/${id}/plan`, payload, ok);
  const commit = (payload: Record<string, unknown>, ok?: string) => act(`/api/trips/${id}/commit`, payload, ok);

  return (
    <div className="space-y-4">
      {/* Header */}
      <section className="hero-sky overflow-hidden rounded-[2rem] px-6 py-6 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Link href="/" className="rounded-full bg-paper/80 px-3 py-1 text-xs text-ink hover:bg-paper">← My trips</Link>
          <div className="flex items-center gap-2">
            <Pill value={trip.status} raw />
            <WhoAmI me={me} onLogout={logout} />
          </div>
        </div>
        <div className="py-6 text-center">
          <p className="font-script text-5xl leading-none text-sage-dark/90 drop-shadow-sm sm:text-7xl">{trip.name}</p>
          <p className="mt-3 text-sm text-ink/80">
            {trip.merchant} · {formatMoney(trip.totalCents, trip.currency)}
            {trip.computed.expensesCents > 0 && (
              <span> (stay {formatMoney(trip.computed.stayCents, trip.currency)} + shared {formatMoney(trip.computed.expensesCents, trip.currency)})</span>
            )}
          </p>
          <p className="mt-1 text-xs uppercase tracking-[0.2em] text-ink/60">
            Deadline {new Date(trip.deadline).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · {timeLeft(trip.deadline)}
          </p>
        </div>
        <div className="flex justify-center -space-x-2">
          {trip.members.map((m) => (
            <span key={m.userId} title={m.name} className="rounded-full ring-2 ring-paper"><Avatar name={m.name} size={32} /></span>
          ))}
        </div>
      </section>

      {notice && (
        <div
          className={`rounded-2xl px-4 py-2 text-sm ${notice.kind === "ok" ? "bg-sage-light text-sage-dark" : notice.kind === "warn" ? "bg-[#f4e6c8] text-[#7a5b1c]" : "bg-[#f3dccf] text-[#9a4f35]"}`}
        >
          {notice.text}{" "}
          <button className="ml-2 text-xs underline" onClick={() => setNotice(null)}>dismiss</button>
        </div>
      )}

      {showInvite && (
        <Card title="👥 Invite friends" right={<button onClick={() => setShowInvite(false)} className="text-xs text-muted hover:underline">close</button>}>
          {locked ? (
            <p className="text-sm text-muted">GroupCommit has started, so the group is closed to new members.</p>
          ) : (
            <>
              <p className="text-sm text-muted">Anyone with this link can join the group after logging in.</p>
              <div className="mt-2 flex items-center gap-2 rounded-md border bg-gray-50 px-3 py-2">
                <span className="flex-1 truncate font-mono text-xs">{joinUrl}</span>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button onClick={() => navigator.clipboard?.writeText(joinUrl).then(() => setNotice({ kind: "ok", text: "Invite link copied." }))}>📋 Copy link</Button>
                <a
                  href={`https://wa.me/?text=${encodeURIComponent(inviteText)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700"
                >
                  Share on WhatsApp
                </a>
                {typeof navigator !== "undefined" && "share" in navigator && (
                  <Button kind="secondary" onClick={() => navigator.share({ title: trip.name, text: inviteText, url: joinUrl }).catch(() => undefined)}>
                    Share…
                  </Button>
                )}
                {isOrganizer && (
                  <Button
                    kind="danger"
                    disabled={busy}
                    onClick={() => confirm("Reset the invite link? The old link will stop working.") && act(`/api/trips/${id}/invite`, {}, "New invite link created; the old one no longer works.")}
                  >
                    Reset link
                  </Button>
                )}
              </div>
            </>
          )}
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-5">
        {/* Shared group chat (AI input arrives in Phase 3) */}
        <div className="lg:col-span-3">
          <Card
            title={`💬 ${trip.name}`}
            right={
              <div className="flex items-center gap-3">
                <span className="flex -space-x-1.5">
                  {trip.members.slice(0, 5).map((m) => (
                    <span key={m.userId} title={m.name} className="rounded-full ring-2 ring-white"><Avatar name={m.name} size={22} /></span>
                  ))}
                </span>
                <button onClick={() => setShowInvite((v) => !v)} className="text-xs font-medium text-emerald-700 hover:underline">
                  + Invite
                </button>
              </div>
            }
          >
            <div className="h-[460px] space-y-2 overflow-y-auto rounded-md bg-[#efeae2] p-3">
              {trip.messages.map((m) =>
                m.from === "system" ? (
                  <p key={m.id} className="mx-auto w-fit max-w-[90%] rounded-md bg-white/80 px-2 py-1 text-center text-xs text-muted shadow-sm">
                    {m.text}
                  </p>
                ) : (
                  <div key={m.id} className={`flex items-end gap-2 ${m.from === me.id ? "justify-end" : ""}`}>
                    {m.from !== me.id && (m.from === "ai" ? <span className="text-xl">🤖</span> : <Avatar name={name(m.from)} size={26} />)}
                    <div
                      className={`max-w-[80%] rounded-lg px-3 py-2 text-left text-sm shadow-sm ${m.from === me.id ? "bg-[#d9fdd3]" : m.from === "ai" ? "border border-indigo-100 bg-indigo-50" : "bg-white"}`}
                    >
                      {m.from !== me.id && <p className={`mb-0.5 text-xs font-semibold ${m.from === "ai" ? "text-indigo-700" : "text-emerald-700"}`}>{name(m.from)}</p>}
                      <p className="whitespace-pre-wrap">{m.text}</p>
                      {m.proposalId && (
                        <ProposalCard
                          trip={trip}
                          proposalId={m.proposalId}
                          meId={me.id}
                          busy={busy}
                          name={name}
                          onVote={(option, decision) =>
                            act(`/api/trips/${id}/agent`, { action: "vote", proposalId: m.proposalId, option, decision })
                          }
                        />
                      )}
                      <p className="mt-0.5 text-right text-[10px] text-gray-400">{new Date(m.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</p>
                    </div>
                  </div>
                ),
              )}
              {pendingMsg && (
                <div className="flex justify-end">
                  <div className="max-w-[80%] rounded-lg bg-[#d9fdd3] px-3 py-2 text-sm opacity-70 shadow-sm">
                    <p className="whitespace-pre-wrap">{pendingMsg}</p>
                    <p className="text-right text-[10px] text-gray-400">sending…</p>
                  </div>
                </div>
              )}
              {aiTyping && (
                <div className="flex items-end gap-2">
                  <span className="text-xl">🤖</span>
                  <p className="rounded-lg border border-indigo-100 bg-indigo-50 px-3 py-2 text-xs text-indigo-700">TripMate is typing…</p>
                </div>
              )}
              <div ref={chatEnd} />
            </div>
            {isMember ? (
              <form
                className="mt-2 flex gap-2"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const text = draft.trim();
                  if (!text || pendingMsg) return;
                  setDraft("");
                  setPendingMsg(text);
                  try {
                    const data = await api<{ trip: TripView }>(`/api/trips/${id}/messages`, { text });
                    setTrip(data.trip);
                  } catch (err) {
                    setDraft(text);
                    setNotice({ kind: "err", text: (err as Error).message });
                  } finally {
                    setPendingMsg(null);
                  }
                }}
              >
                <input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder={locked ? "Ask TripMate, or say if you can't pay…" : 'e.g. "Main sirf 2 raat rukungi" or "I want the private room, $40 extra"'}
                  className="flex-1 rounded-full border px-4 py-2 text-sm"
                />
                <button disabled={!!pendingMsg || !draft.trim()} className="rounded-full bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
                  Send
                </button>
              </form>
            ) : (
              <p className="mt-2 text-xs text-gray-400">You're not a member of this trip.</p>
            )}
          </Card>
        </div>

        {/* Right panel */}
        <div className="space-y-4 lg:col-span-2">
          {/* Plan */}
          <Card title={`The plan · v${trip.plan.version}${locked ? " 🔒" : ""}`}>
            <table className="w-full text-sm">
              <tbody>
                {trip.members.map((m) => {
                  const s = shareOf(m.userId);
                  const approved = trip.plan.approvals[m.userId] === trip.plan.version;
                  const mine = m.userId === me.id;
                  return (
                    <tr key={m.userId} className="border-t align-top">
                      <td className="py-2">
                        <p className="font-medium">
                          {m.name} {m.userId === trip.organizerId && <span className="text-xs text-gray-400">org</span>}
                          {m.status === "DROPPED" && <span className="ml-1 text-xs text-red-500">dropped</span>}
                        </p>
                        <p className="text-xs text-muted">{s?.explanation}</p>
                      </td>
                      <td className="py-2 text-xs">
                        {mine && !locked ? (
                          <select
                            value={m.nights}
                            disabled={busy}
                            onChange={(e) => plan({ action: "nights", nights: Number(e.target.value) })}
                            className="rounded border px-1 py-0.5"
                          >
                            {[0, 1, 2, 3, 4, 5, 6, 7].map((n) => (
                              <option key={n} value={n}>{n} nights</option>
                            ))}
                          </select>
                        ) : (
                          `${m.nights} nights`
                        )}
                      </td>
                      <td className="py-2 text-right font-medium">{s ? formatMoney(s.cents, trip.currency) : "–"}</td>
                      <td className="py-2 pl-2 text-right">{approved ? "✓" : <span className="text-gray-300">○</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!locked && isMember && (
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  disabled={busy || trip.plan.approvals[me.id] === trip.plan.version}
                  onClick={() => plan({ action: "approve", version: trip.plan.version }, "You approved your share.")}
                >
                  {trip.plan.approvals[me.id] === trip.plan.version ? "✓ You approved" : `Approve my share (v${trip.plan.version})`}
                </Button>
                {isOrganizer && (
                  <Button
                    kind="secondary"
                    disabled={busy || !trip.computed.allApproved}
                    onClick={() => commit({ action: "start" }, "GroupCommit started. Everyone can now commit with PayPal.")}
                  >
                    Start GroupCommit {trip.computed.allApproved ? "" : "(needs all ✓)"}
                  </Button>
                )}
              </div>
            )}
            {isOrganizer && !locked && (
              <details className="mt-3 text-sm">
                <summary className="cursor-pointer text-muted">Add an extra for a member</summary>
                <div className="mt-2 flex flex-wrap items-end gap-2">
                  <select value={surcharge.memberId} onChange={(e) => setSurcharge({ ...surcharge, memberId: e.target.value })} className="rounded border px-2 py-1">
                    <option value="">member…</option>
                    {trip.members.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
                  </select>
                  <input value={surcharge.amount} onChange={(e) => setSurcharge({ ...surcharge, amount: e.target.value })} className="w-16 rounded border px-2 py-1" />
                  <input value={surcharge.reason} onChange={(e) => setSurcharge({ ...surcharge, reason: e.target.value })} className="w-32 rounded border px-2 py-1" />
                  <Button kind="secondary" disabled={busy || !surcharge.memberId} onClick={() => plan({ action: "surcharge", ...surcharge })}>Save</Button>
                </div>
              </details>
            )}
          </Card>

          {/* Shared expenses beyond the stay */}
          <Card title="Shared expenses" right={<span className="text-xs text-muted">{formatMoney(trip.computed.expensesCents, trip.currency)}</span>}>
            <p className="text-xs text-muted">Food, cabs, tickets and activities on top of the stay. Split equally between the people who join. You can also just say it in the chat: “dinner $60 sabka”.</p>
            {(trip.plan.expenses ?? []).length === 0 ? (
              <p className="mt-3 rounded-2xl bg-cream px-3 py-3 text-center text-sm text-muted">No shared expenses yet</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {(trip.plan.expenses ?? []).map((e) => (
                  <li key={e.id} className="flex items-center justify-between gap-2 rounded-2xl bg-cream px-3 py-2 text-sm">
                    <span>
                      {CATEGORY_ICON[e.category] ?? "🧾"} <b className="font-medium">{e.title}</b>
                      <span className="block text-xs text-muted">
                        split between {e.participantIds.length ? e.participantIds.map(name).join(", ") : "everyone"} · added by {name(e.addedBy)}
                      </span>
                    </span>
                    <span className="flex items-center gap-2">
                      <b>{formatMoney(e.cents, trip.currency)}</b>
                      {!locked && (e.addedBy === me.id || isOrganizer) && (
                        <button disabled={busy} onClick={() => plan({ action: "expense_remove", expenseId: e.id })} className="text-xs text-clay hover:underline">remove</button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {!locked && isMember && (
              <form
                className="mt-3 space-y-2 rounded-2xl bg-sage-light/50 p-3"
                onSubmit={(ev) => {
                  ev.preventDefault();
                  plan({ action: "expense_add", ...expense }, "Expense added. Everyone needs to re-approve the plan.").then(() =>
                    setExpense({ title: "", amount: "", category: expense.category, participantIds: [] }),
                  );
                }}
              >
                <div className="flex flex-wrap gap-2">
                  <select value={expense.category} onChange={(e) => setExpense({ ...expense, category: e.target.value })} className="rounded-full bg-white px-3 py-1.5 text-sm ring-1 ring-sand">
                    <option value="food">🍽️ Food</option>
                    <option value="transport">🚕 Transport</option>
                    <option value="activity">🎟️ Activity</option>
                    <option value="other">🧾 Other</option>
                  </select>
                  <input required value={expense.title} onChange={(e) => setExpense({ ...expense, title: e.target.value })} placeholder="e.g. Beach dinner" className="min-w-0 flex-1 rounded-full bg-white px-3 py-1.5 text-sm ring-1 ring-sand" />
                  <input required type="number" min="0.01" step="0.01" value={expense.amount} onChange={(e) => setExpense({ ...expense, amount: e.target.value })} placeholder="$" className="w-20 rounded-full bg-white px-3 py-1.5 text-sm ring-1 ring-sand" />
                </div>
                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  <span className="text-muted">Who's in:</span>
                  <button type="button" onClick={() => setExpense({ ...expense, participantIds: [] })} className={`rounded-full px-2.5 py-1 ${expense.participantIds.length === 0 ? "bg-sage text-white" : "bg-white ring-1 ring-sand"}`}>Everyone</button>
                  {trip.members.filter((m) => m.status === "ACTIVE").map((m) => {
                    const on = expense.participantIds.includes(m.userId);
                    return (
                      <button
                        type="button"
                        key={m.userId}
                        onClick={() => setExpense({ ...expense, participantIds: on ? expense.participantIds.filter((x) => x !== m.userId) : [...expense.participantIds, m.userId] })}
                        className={`rounded-full px-2.5 py-1 ${on ? "bg-sage text-white" : "bg-white ring-1 ring-sand"}`}
                      >
                        {m.name}
                      </button>
                    );
                  })}
                </div>
                <Button type="submit" kind="secondary" disabled={busy || !expense.title.trim() || !expense.amount}>+ Add expense</Button>
              </form>
            )}
          </Card>

          {/* Where the money goes */}
          <Card title="Where the money goes" tone="sage">
            <p className="text-sm text-white/85">
              Every PayPal hold pays <b>{trip.merchant}</b>
              {trip.merchantInfo?.bookingRef && <> · booking {trip.merchantInfo.bookingRef}</>}.
            </p>
            {trip.payee?.merchantId ? (
              <div className="mt-3 rounded-2xl bg-white/10 px-3 py-2 text-xs">
                <p>✅ Verified by PayPal on the order</p>
                <p className="mt-1 font-mono text-white/80">merchant ID {trip.payee.merchantId}</p>
                {trip.payee.email && <p className="font-mono text-white/80">{trip.payee.email}</p>}
              </div>
            ) : (
              <p className="mt-3 rounded-2xl bg-white/10 px-3 py-2 text-xs text-white/80">PayPal confirms the receiving merchant account when GroupCommit starts.</p>
            )}
            {trip.computed.payeeMatchesMerchant === false && (
              <p className="mt-2 rounded-2xl bg-[#f3dccf] px-3 py-2 text-xs text-[#9a4f35]">
                Heads up: PayPal's payee ({trip.payee?.email}) is not the merchant email entered ({trip.merchantInfo?.paypalEmail}). In this demo the app's PayPal business account receives the money on the merchant's behalf.
              </p>
            )}
            <p className="mt-3 text-xs text-white/60">Before capture, the app checks every hold still pays this same merchant. If not, capture is blocked.</p>
          </Card>

          {/* Commitment board */}
          {locked && (
            <Card title="🔒 GroupCommit board">
              {["COLLECTING", "AT_RISK", "COMMITTED"].includes(trip.status) && (
                <p className="mb-3 rounded-2xl bg-sage-light px-3 py-2 text-xs text-sage-dark">
                  🤖 <b>Autopilot on.</b> The AI agent watches this group. If someone hasn't committed 30 min before the deadline, it checks PayPal and proposes options in the chat. Nothing happens without your approval.
                </p>
              )}
              <div className="mb-2 flex justify-between text-sm">
                <span>
                  Committed <b>{formatMoney(trip.computed.committedCents, trip.currency)}</b> / {formatMoney(trip.totalCents, trip.currency)}
                </span>
                <span className="text-muted">gap {formatMoney(trip.computed.gapCents, trip.currency)}</span>
              </div>
              <div className="mb-3 h-2 overflow-hidden rounded-full bg-sand">
                <div className="h-full bg-sage transition-all" style={{ width: `${pct}%` }} />
              </div>
              <ul className="space-y-2 text-sm">
                {trip.commitments.map((c) => (
                  <li key={c.orderId} className="rounded-2xl bg-cream p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span>
                        <b>{name(c.memberId)}</b>
                        {c.onBehalfOf && <span className="text-xs text-muted"> for {name(c.onBehalfOf)}</span>}
                        {c.kind !== "SHARE" && <span className="ml-1 text-xs text-gray-400">{c.kind.toLowerCase()}</span>}
                      </span>
                      <span className="flex items-center gap-2">
                        {formatMoney(c.cents, c.currency)} <Pill value={c.status} />
                      </span>
                    </div>
                    <div className="mt-1 flex justify-between text-xs">
                      <span className="font-mono text-gray-400">{c.orderId}</span>
                      <span className="space-x-3">
                        {c.status === "CREATED" && c.approveUrl && c.memberId === me.id && (
                          <a href={c.approveUrl} className="font-medium text-clay hover:underline">Commit with PayPal ↗</a>
                        )}
                        {c.status === "CREATED" && c.approveUrl && c.memberId !== me.id && (
                          <button onClick={() => navigator.clipboard?.writeText(c.approveUrl!)} className="text-muted hover:underline">copy link</button>
                        )}
                        {isMember && (
                          <button onClick={() => commit({ action: "refresh", orderId: c.orderId }, "Checked with PayPal.")} className="text-muted hover:underline">
                            check PayPal
                          </button>
                        )}
                      </span>
                    </div>
                    {c.lastError && <p className="mt-1 text-xs text-red-600">{c.lastError}</p>}
                  </li>
                ))}
              </ul>

              {isOrganizer && (
                <div className="mt-4 flex flex-wrap gap-2 border-t pt-3">
                  {trip.status === "COMMITTED" && (
                    <Button disabled={busy} onClick={() => commit({ action: "finalize" }, "Captured all holds via PayPal.")}>
                      Finalize: capture all
                    </Button>
                  )}
                  {trip.status === "FUNDED" && (
                    <Button disabled={busy} onClick={() => commit({ action: "confirm" })}>Mark hostel confirmed</Button>
                  )}
                  {["COLLECTING", "AT_RISK", "COMMITTED"].includes(trip.status) && (
                    <>
                      <Button
                        kind="secondary"
                        disabled={busy}
                        onClick={() => commit({ action: "demo_deadline" }, "Deadline moved to 30 min from now. Autopilot checked the group.")}
                      >
                        ⏰ Demo: deadline in 30 min
                      </Button>
                      <Button kind="secondary" disabled={busy} onClick={() => act(`/api/trips/${id}/agent`, { action: "run", trigger: "MANUAL" })}>
                        🤖 Ask agent
                      </Button>
                      <Button kind="danger" disabled={busy} onClick={() => confirm("Cancel the booking and release every PayPal hold?") && commit({ action: "void" })}>
                        Cancel: release all holds
                      </Button>
                    </>
                  )}
                </div>
              )}
            </Card>
          )}

          {/* Ledger (who owes whom after covers) */}
          {trip.ledger.length > 0 && (
            <Card title="🧾 Balances">
              <ul className="space-y-1 text-sm">
                {trip.ledger.map((l, i) => (
                  <li key={i}>
                    <b>{name(l.from)}</b> owes <b>{name(l.to)}</b> {formatMoney(l.cents, trip.currency)}{" "}
                    <span className="text-xs text-muted">({l.reason})</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {/* Timeline */}
          <Card title="🕒 Timeline">
            <ul className="max-h-56 space-y-1 overflow-y-auto text-xs">
              {[...trip.timeline].reverse().map((e, i) => (
                <li key={i} className="flex gap-2">
                  <span className="shrink-0 text-gray-400">{new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                  <span className="shrink-0">{e.actor === "paypal" ? "💳" : e.actor === "ai" ? "🤖" : e.actor === "webhook" ? "📡" : "👤"}</span>
                  <span>{e.text}</span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}

function ProposalCard({
  trip,
  proposalId,
  meId,
  busy,
  name,
  onVote,
}: {
  trip: TripView;
  proposalId: string;
  meId: string;
  busy: boolean;
  name: (id: string) => string;
  onVote: (option: string, decision: "YES" | "NO") => void;
}) {
  const p = trip.proposals.find((x) => x.id === proposalId);
  if (!p) return null;
  return (
    <div className="mt-2 space-y-2 rounded-2xl border border-clay/30 bg-[#fbf3ee] p-2 text-ink">
      <div className="flex flex-wrap items-center justify-between gap-1 text-xs">
        <span>
          {p.aiPowered ? `🤖 ${p.aiModel ?? "AI"} + PayPal Agent Toolkit` : "Rule-based (AI offline)"} · PayPal checks:{" "}
          {p.paypalChecks.map((c) => `${c.orderId.slice(0, 6)}… ${c.status}`).join(", ") || "none"}
        </span>
        <Pill value={p.status} raw />
      </div>
      {p.options.map((o) => {
        const mustVote = p.status === "OPEN" && o.status === "OPEN" && o.requiredApprovers.includes(meId) && !o.votes[meId];
        return (
          <div key={o.type} className={`rounded-xl bg-white p-2 ring-1 ${p.recommended === o.type ? "ring-sage" : "ring-sand"}`}>
            <div className="flex items-start justify-between gap-2">
              <p className="font-medium">
                {o.title} {p.recommended === o.type && <span className="text-xs text-indigo-600">★ recommended</span>}
              </p>
              <span className="text-xs text-muted">{o.status.toLowerCase()}</span>
            </div>
            <p className="text-xs text-muted">{o.detail}</p>
            {o.aiNote && <p className="mt-1 text-xs italic text-gray-700">🤖 {o.aiNote}</p>}
            <p className="mt-1 text-xs text-muted">
              Needs: {o.requiredApprovers.map((a) => `${name(a)} ${o.votes[a] === "YES" ? "✓" : o.votes[a] === "NO" ? "✗" : "…"}`).join(" · ")}
            </p>
            {o.error && <p className="text-xs text-red-600">{o.error}</p>}
            {mustVote && (
              <div className="mt-1 flex gap-2">
                <Button disabled={busy} onClick={() => onVote(o.type, "YES")}>Approve</Button>
                <Button kind="secondary" disabled={busy} onClick={() => onVote(o.type, "NO")}>Decline</Button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
