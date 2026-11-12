"use client";
import type { Identity } from "@/lib/client";

const STYLE: Record<string, string> = {
  PLANNING: "bg-sand text-ink",
  COLLECTING: "bg-sage-light text-sage-dark",
  AT_RISK: "bg-[#f3dccf] text-[#9a4f35]",
  COMMITTED: "bg-sage text-white",
  FUNDED: "bg-sage-dark text-white",
  CONFIRMED: "bg-ink text-paper",
  CANCELLED: "bg-sand text-muted line-through",
  CREATED: "bg-[#f4e6c8] text-[#7a5b1c]",
  AUTHORIZED: "bg-sage-light text-sage-dark",
  CAPTURED: "bg-sage text-white",
  CAPTURE_FAILED: "bg-[#f3dccf] text-[#9a4f35]",
  VOIDED: "bg-sand text-muted",
  OPEN: "bg-[#f3dccf] text-[#9a4f35]",
  RESOLVED: "bg-sage-light text-sage-dark",
  STALE: "bg-sand text-muted",
};

const LABEL: Record<string, string> = {
  CREATED: "⏳ not committed",
  AUTHORIZED: "🔒 on hold",
  CAPTURED: "✅ captured",
  CAPTURE_FAILED: "❌ capture failed",
  VOIDED: "🔓 released",
  CANCELLED: "cancelled",
};

export function Pill({ value, raw }: { value: string; raw?: boolean }) {
  return (
    <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${STYLE[value] ?? "bg-gray-100"}`}>
      {raw ? value : (LABEL[value] ?? value)}
    </span>
  );
}

export function Card({
  title,
  children,
  right,
  tone = "paper",
}: {
  title: React.ReactNode;
  children: React.ReactNode;
  right?: React.ReactNode;
  tone?: "paper" | "sage";
}) {
  const sage = tone === "sage";
  return (
    <section className={`rounded-3xl p-5 shadow-sm ring-1 ${sage ? "bg-sage text-white ring-sage-dark/20" : "bg-paper ring-sand"}`}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className={`font-display text-lg ${sage ? "text-white" : "text-ink"}`}>{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

export function Button({
  children,
  onClick,
  disabled,
  kind = "primary",
  type,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  kind?: "primary" | "secondary" | "danger" | "light";
  type?: "button" | "submit";
}) {
  const cls =
    kind === "primary"
      ? "bg-sage-dark text-white hover:bg-ink"
      : kind === "danger"
        ? "border border-clay/50 text-clay hover:bg-clay/10"
        : kind === "light"
          ? "bg-paper text-ink hover:bg-white"
          : "border border-sage/40 text-sage-dark hover:bg-sage-light/60";
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-full px-4 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${cls}`}
    >
      {children}
    </button>
  );
}

/** "Grape & Gold" style heading: serif words joined by a script ampersand. */
export function ScriptTitle({ left, right, className = "" }: { left: string; right: string; className?: string }) {
  return (
    <h1 className={`font-display text-ink ${className}`}>
      {left} <span className="font-script -mx-1 align-middle text-[1.4em] leading-none text-clay">&amp;</span> {right}
    </h1>
  );
}

export function Avatar({ name, size = 28 }: { name: string; size?: number }) {
  const colors = ["bg-[#7b8069]", "bg-[#c4775c]", "bg-[#8f7a62]", "bg-[#5d624f]", "bg-[#b08d57]", "bg-[#6c7f86]"];
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white ${colors[h % colors.length]}`}
      style={{ width: size, height: size, fontSize: size * 0.42 }}
    >
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}

export function WhoAmI({ me, onLogout }: { me: Identity; onLogout: () => void }) {
  return (
    <div className="flex items-center gap-2 rounded-full bg-paper px-2 py-1 text-xs text-muted ring-1 ring-sand">
      <Avatar name={me.name} size={22} />
      <span>
        <b className="text-ink">{me.name}</b> {me.email && <span className="hidden sm:inline">· {me.email}</span>}
      </span>
      <button onClick={onLogout} className="rounded-full px-2 text-clay hover:underline">
        log out
      </button>
    </div>
  );
}
