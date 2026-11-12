// All money in this app is stored as integer minor units (cents).
// Only convert to a decimal string at the PayPal API boundary.

export function toCents(value: number | string): number {
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) throw new Error(`Invalid amount: ${value}`);
  return Math.round(n * 100);
}

export function centsToValue(cents: number): string {
  if (!Number.isInteger(cents)) throw new Error(`Cents must be an integer: ${cents}`);
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}
