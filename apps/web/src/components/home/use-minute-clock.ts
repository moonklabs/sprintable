'use client';

import { useSyncExternalStore } from 'react';

/**
 * story #4888 (UI-5 home) — «now», rounded down to the minute, and refreshed AT the minute boundary (not 60 s after it was mounted): what the detail's «기다린 시간» needs — it shows whole minutes,
 * so a value that is up to a minute stale would print the wrong number — without reading the clock during render.
 */
const MINUTE = 60_000;
const read = () => Math.floor(Date.now() / MINUTE) * MINUTE;
const subscribe = (onChange: () => void) => {
  let timer: ReturnType<typeof setTimeout>;
  const arm = () => {
    timer = setTimeout(() => { onChange(); arm(); }, MINUTE - (Date.now() % MINUTE));
  };
  arm();
  return () => clearTimeout(timer);
};

export function useMinuteClock(): number {
  return useSyncExternalStore(subscribe, read, read);
}
