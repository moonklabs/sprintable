/**
 * story #4888 (UI-5 home) — «기다린 시간»: how long a row has been waiting, as one number and one unit. Minutes under an hour, hours under two days, days after that.
 * A time in the future or a value that is not a date never prints a negative or `NaN` — it reads «방금» (just now), the honest floor.
 */
export type WaitedUnit = 'now' | 'minutes' | 'hours' | 'days';
export interface Waited { unit: WaitedUnit; count: number }

export function waitedSince(sinceIso: string, now: number): Waited {
  const ms = now - Date.parse(sinceIso);
  if (!Number.isFinite(ms) || ms < 60_000) return { unit: 'now', count: 0 };
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return { unit: 'minutes', count: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return { unit: 'hours', count: hours };
  return { unit: 'days', count: Math.floor(hours / 24) };
}
