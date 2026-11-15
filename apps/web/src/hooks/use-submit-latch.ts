'use client';

import { useCallback, useEffect, useRef } from 'react';

/** How long a button that was HELD for a navigation may stay locked if that navigation never happens (offline · a push to where the person already is). */
export const SUBMIT_HOLD_FALLBACK_MS = 15_000;

/**
 * story 4940 — the submit of a form that LEAVES the page on success (sign up · log in · the second-step code). Two promises, one place:
 * - **one press = one request.** `enter()` is a latch (a ref, not state): a second press in the same frame, or while the first is still going, gets `false` and sends nothing — the 409 «second sign-up» of the slow phone.
 * - **a success keeps the button locked until the page is left.** `router.push` / `replace` does not wait for the new screen: a `finally { setLoading(false) }` right after it hands the same form back, enabled, for the seconds the next screen takes
 *   (3 s measured on dev with CPU ×4 + Slow 4G — it looks like a fresh form, and presses again). So the success road calls `hold()` where it starts the navigation; `exit()` (the `finally`) then releases only a road that did NOT hold.
 *   The lock ends with the page (the form unmounts when the screen changes); if the navigation never happens it lets go by itself after `fallbackMs`, so nobody is locked for good.
 * A failure road never calls `hold()`: `exit()` releases at once and the reason is on screen. A road that held and THEN failed (the navigation itself threw) calls `unhold()` first, so its `exit()` releases at once as well.
 * `setLoading` is any `(busy: boolean) => void` — a `useState` setter, or one setter for a form with several roads (the login: ONE latch for the password road and the Firebase road, so one road's lock holds the other's buttons too).
 */
export function useSubmitLatch(setLoading: (busy: boolean) => void, fallbackMs: number = SUBMIT_HOLD_FALLBACK_MS) {
  const busy = useRef(false);
  const held = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; if (timer.current) clearTimeout(timer.current); };
  }, []);

  /** Start a submit: `false` (do nothing) while one is already going. */
  const enter = useCallback((): boolean => {
    if (busy.current) return false;
    busy.current = true;
    held.current = false;
    setLoading(true);
    return true;
  }, [setLoading]);

  /** The success road, right where it starts the navigation: keep the button locked until the page is left. */
  const hold = useCallback((): void => {
    if (!alive.current) return; // the page is already gone (the answer came after it was left): no lock, no timer
    held.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      held.current = false;
      busy.current = false;
      if (alive.current) setLoading(false);
    }, fallbackMs);
  }, [setLoading, fallbackMs]);

  /** The road held and then FAILED (the navigation threw): take the hold back, so the `finally` releases at once. */
  const unhold = useCallback((): void => {
    held.current = false;
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
  }, []);

  /** The `finally`: release unless this road held. */
  const exit = useCallback((): void => {
    if (held.current) return;
    busy.current = false;
    setLoading(false);
  }, [setLoading]);

  return { enter, hold, unhold, exit };
}
