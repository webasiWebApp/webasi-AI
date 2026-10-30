// Money is LKR only. Sums are taken in whole cents so 0.1 + 0.2 never drifts; database numeric(14,2) values arrive as numbers.
export const toCents = (value: number | string | null | undefined): number => Math.round(Number(value ?? 0) * 100);
export const fromCents = (cents: number) => cents / 100;

// price x percent / 100, to the cent, like the database's round(price_total * advance_percent / 100, 2).
export function requiredAdvanceCents(priceCents: number, percent: number) {
  return Math.round((priceCents * Math.round(percent * 100)) / 10_000);
}
export const requiredAdvance = (price: number, percent: number) => fromCents(requiredAdvanceCents(toCents(price), percent));

// "LKR 40,000", with the cents only when there are some: "LKR 40,000.50".
export function formatLkr(amount: number | string | null | undefined) {
  const cents = toCents(amount);
  const text = fromCents(Math.abs(cents)).toLocaleString("en-US", { minimumFractionDigits: cents % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 });
  return `${cents < 0 ? "-" : ""}LKR ${text}`;
}
