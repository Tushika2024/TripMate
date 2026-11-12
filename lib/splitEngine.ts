// Deterministic fair-split engine. The AI never does the arithmetic:
// it only produces facts (nights, extras, shared expenses); this code turns them into exact cents.
//  - Stay: split by nights (surcharges like a private room come out of the stay total first).
//  - Shared expenses (food, cab, activities): split equally among that expense's participants.
// Every split uses the largest-remainder method, so the sum is always exact.
import type { Expense, Member, Share, Surcharge } from "./store";
import { formatMoney } from "./money";

export class SplitError extends Error {}

/** Split `cents` across `weights` exactly (largest-remainder). */
function apportion(cents: number, weights: number[]): number[] {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return weights.map(() => 0);
  const exact = weights.map((w) => (cents * w) / total);
  const out = exact.map(Math.floor);
  let leftover = cents - out.reduce((a, b) => a + b, 0);
  const order = exact.map((v, i) => ({ i, frac: v - Math.floor(v) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (leftover <= 0) break;
    out[i] += 1;
    leftover -= 1;
  }
  return out;
}

export function expensesTotal(expenses: Expense[] = []) {
  return expenses.reduce((a, e) => a + e.cents, 0);
}

export function calculateShares(
  stayCents: number,
  members: Member[],
  surcharges: Surcharge[],
  currency: string,
  expenses: Expense[] = [],
): Share[] {
  const active = members.filter((m) => m.status === "ACTIVE");
  if (active.length === 0) return [];
  if (!Number.isInteger(stayCents) || stayCents <= 0) throw new SplitError("Trip total must be positive");

  const activeIds = new Set(active.map((m) => m.userId));
  const extras = surcharges.filter((s) => activeIds.has(s.memberId));
  const extraTotal = extras.reduce((a, s) => a + s.cents, 0);
  const base = stayCents - extraTotal;
  if (base < 0) throw new SplitError("Surcharges are larger than the trip total");

  const totalNights = active.reduce((a, m) => a + Math.max(0, m.nights), 0);
  if (totalNights === 0) throw new SplitError("At least one member must stay one night");

  // 1) Stay by nights.
  const stay = apportion(base, active.map((m) => Math.max(0, m.nights)));
  const perNight = base / totalNights;

  // 2) Shared expenses, equally among participants still in the trip
  //    (if every participant dropped out, the remaining group shares it).
  const expenseCents = active.map(() => 0);
  const expenseNotes: string[][] = active.map(() => []);
  for (const e of expenses) {
    if (!Number.isInteger(e.cents) || e.cents <= 0) continue;
    let who = active.map((m, i) => (e.participantIds.length === 0 || e.participantIds.includes(m.userId) ? i : -1)).filter((i) => i >= 0);
    if (who.length === 0) who = active.map((_, i) => i);
    const parts = apportion(e.cents, who.map(() => 1));
    who.forEach((i, k) => {
      expenseCents[i] += parts[k];
      expenseNotes[i].push(`+${formatMoney(parts[k], currency)} ${e.title}`);
    });
  }

  const shares: Share[] = active.map((m, i) => {
    const own = extras.filter((s) => s.memberId === m.userId);
    const ownExtra = own.reduce((a, s) => a + s.cents, 0);
    const parts = [`${m.nights} night${m.nights === 1 ? "" : "s"} × ~${formatMoney(Math.round(perNight), currency)}`];
    for (const s of own) parts.push(`+${formatMoney(s.cents, currency)} ${s.reason}`);
    parts.push(...expenseNotes[i]);
    return { memberId: m.userId, cents: stay[i] + ownExtra + expenseCents[i], explanation: parts.join(" ") };
  });

  const expected = stayCents + expensesTotal(expenses.filter((e) => e.cents > 0));
  const sum = shares.reduce((a, s) => a + s.cents, 0);
  if (sum !== expected) throw new SplitError(`Split mismatch: ${sum} != ${expected}`);
  return shares;
}
