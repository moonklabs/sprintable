// story 4712 — [열기] per person: this many presses in this long (a person presses it once or twice). In-memory, so the count is per server
// instance — a bound against a loop, not an exact meter. (Kept out of the route file: a route file may export only its HTTP methods.)
const WINDOW_MS = 10 * 60_000;
const MAX_PER_WINDOW = 10;
const recent = new Map<string, number[]>();

/** true = this person is over the limit (the press is NOT counted); false = counted, go on */
export function overContinueLimit(userId: string, now: number): boolean {
  const stamps = (recent.get(userId) ?? []).filter((t) => now - t < WINDOW_MS);
  if (stamps.length >= MAX_PER_WINDOW) { recent.set(userId, stamps); return true; }
  stamps.push(now);
  recent.set(userId, stamps);
  return false;
}

/** test hook — the count is module state */
export function resetContinueLimitForTests(): void { recent.clear(); }
