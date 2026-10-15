// Lets an end-to-end test shorten a timeout from the URL (e.g. /meet?aloneMs=5000)
// instead of waiting minutes. Development only: NODE_ENV is inlined at build
// time, so in a production bundle this is just `return ms` and the query string
// is never read — a visitor can't stretch or shrink the real limits.
// Call it from effects/handlers, not during render (it reads window).
export function devTimeout(param: string, ms: number): number {
  if (process.env.NODE_ENV === "production" || typeof window === "undefined") return ms;
  const raw = new URLSearchParams(window.location.search).get(param);
  const v = raw === null ? NaN : Number(raw);
  return Number.isFinite(v) && v > 0 ? v : ms;
}
