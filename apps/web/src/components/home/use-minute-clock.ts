'use client';

import { useSyncExternalStore } from 'react';

/** story #4888 (UI-5 home) — «now», rounded down to the minute and refreshed once a minute: what the detail's «기다린 시간» needs (it never prints seconds) without reading the clock during render. */
const MINUTE = 60_000;
const subscribe = (onChange: () => void) => {
  const id = setInterval(onChange, MINUTE);
  return () => clearInterval(id);
};
const read = () => Math.floor(Date.now() / MINUTE) * MINUTE;

export function useMinuteClock(): number {
  return useSyncExternalStore(subscribe, read, read);
}
