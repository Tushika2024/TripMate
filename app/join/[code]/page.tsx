"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { api, goToLogin, useAuth } from "@/lib/client";
import { Avatar } from "@/components/ui";
import { formatMoney } from "@/lib/money";

interface Invite {
  name: string;
  merchant: string;
  totalCents: number;
  currency: string;
  deadline: string;
  organizer: string;
  members: string[];
  closed: boolean;
  status: string;
  isMember: boolean;
  tripId: string | null;
}

export default function JoinPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const { me, ready } = useAuth();
  const [invite, setInvite] = useState<Invite | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!ready) return;
    api<{ invite: Invite }>(`/api/invite/${encodeURIComponent(code)}`)
      .then((d) => {
        // Already in the group: go straight to the chat, like WhatsApp does.
        if (d.invite.isMember && d.invite.tripId) window.location.replace(`/t/${d.invite.tripId}`);
        else setInvite(d.invite);
      })
      .catch((e) => setError((e as Error).message));
  }, [code, ready, me]);

  async function join() {
    if (!me) return goToLogin(`/join/${code}`);
    setBusy(true);
    setError(null);
    try {
      const { tripId } = await api<{ tripId: string }>(`/api/invite/${encodeURIComponent(code)}`, {});
      window.location.replace(`/t/${tripId}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  if (error && !invite) {
    return (
      <div className="mx-auto mt-16 max-w-sm rounded-xl border bg-white p-6 text-center">
        <p className="text-3xl">🔗</p>
        <h1 className="mt-2 font-semibold">Invite link not working</h1>
        <p className="mt-1 text-sm text-gray-600">{error}</p>
        <Link href="/" className="mt-4 inline-block text-sm text-blue-600 underline">Go to my trips</Link>
      </div>
    );
  }
  if (!invite) return <p className="mt-16 text-center text-gray-500">Opening invite…</p>;

  return (
    <div className="mx-auto mt-10 max-w-sm overflow-hidden rounded-xl border bg-white text-center shadow-sm">
      <div className="bg-sage-dark px-6 py-6 text-white">
        <p className="text-4xl">🧳</p>
        <h1 className="mt-2 text-xl font-semibold">{invite.name}</h1>
        <p className="text-sm opacity-90">Group trip · {invite.members.length} member{invite.members.length === 1 ? "" : "s"}</p>
      </div>
      <div className="space-y-4 p-6">
        <p className="text-sm text-gray-700">
          <b>{invite.organizer}</b> invited you to plan and split <b>{invite.merchant}</b> ({formatMoney(invite.totalCents, invite.currency)}) together.
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          {invite.members.slice(0, 8).map((n, i) => (
            <span key={i} className="flex items-center gap-1 rounded-full bg-gray-100 py-0.5 pl-0.5 pr-2 text-xs">
              <Avatar name={n} size={20} /> {n}
            </span>
          ))}
        </div>
        <ul className="space-y-1 rounded-md bg-gray-50 p-3 text-left text-xs text-gray-600">
          <li>💬 One shared group chat with an AI that keeps one plan</li>
          <li>🔒 You commit with PayPal as a hold; nothing is charged until the group is ready</li>
          <li>🤖 An AI agent watches the deadline and suggests fixes; you approve</li>
        </ul>
        {invite.closed ? (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">This group already started paying, so it's closed to new members.</p>
        ) : (
          <button onClick={join} disabled={busy} className="w-full rounded-full bg-sage-dark px-4 py-2.5 font-medium text-white hover:bg-ink disabled:opacity-50">
            {busy ? "Joining…" : me ? `Join group as ${me.name}` : "Log in or sign up to join"}
          </button>
        )}
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
    </div>
  );
}
