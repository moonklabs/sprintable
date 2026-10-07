'use client';

/**
 * story #4535 (PO 18:58Z · 미르코 실측 `combined-r3/1-chip-on.png`) — one reading of the org's «원격 제어» for /desktop. The switch card
 * and «원격 기기» used to read it each on their own, once: after turning it on, «원격 기기» still said «꺼져 있어요». Now both look at
 * the same value — read once per org while someone on the page shows it, and replaced by the switch's own answer when it changes
 * (a failed change sets nothing, so neither moves). Dropped when the last one leaves, so the next visit reads it again — but not
 * while a read is still out (까디르 4944 ②: a remount would read twice), and a read's answer never covers a change made after it
 * started (① a late «off» from a read begun before [켬] put the switch back off while the server was on): every change moves the
 * entry's generation, and a read lands only on the generation it began on.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { fetchWithAuth } from '@/lib/db/client';

export interface OrgRemoteControl {
  enabled: boolean;
  enabled_at: string | null;
  can_change: boolean;
  /** story #4583: the owners' display names (no email · no id) — named to everyone else while it is off */
  owner_names?: string[];
  /** story #4583: how many of the org's computers are connected (a count) — the approvals line shows only with one */
  connected_computers?: number;
}

interface Entry { value: OrgRemoteControl | null; listeners: Set<() => void>; asked: boolean; reading: boolean; gen: number }
const entries = new Map<string, Entry>();

function entry(orgId: string): Entry {
  let e = entries.get(orgId);
  if (!e) { e = { value: null, listeners: new Set(), asked: false, reading: false, gen: 0 }; entries.set(orgId, e); }
  return e;
}

function publish(e: Entry, value: OrgRemoteControl | null): void {
  e.value = value;
  for (const l of e.listeners) l();
}

/** the last one left: drop it — unless a read is still out (it drops it when it lands) */
function release(orgId: string, e: Entry): void {
  const unused = () => e.listeners.size === 0 && !e.reading && entries.get(orgId) === e;
  if (!unused()) return;
  // story #4583 (AC6 · the 결재함 link → /desktop): one place leaving and the next one arriving happen in the same commit, the
  // leaving cleanup first — dropping at once made the arriving card start from nothing (no switch → read again → a new switch),
  // which threw away the focus the link's arrival had just put there. Drop on the next microtask, if still nobody listens: a real
  // leave still drops it (the next visit reads again), a hand-over keeps it.
  queueMicrotask(() => { if (unused()) entries.delete(orgId); });
}

function read(orgId: string): void {
  const e = entry(orgId);
  if (e.asked) return;
  e.asked = true;
  e.reading = true;
  const began = e.gen;
  void fetchWithAuth(`/api/organizations/${orgId}/remote-control`)
    .then(async (res) => (res.ok ? ((await res.json()) as { data?: OrgRemoteControl }).data ?? null : null))
    .catch(() => null)
    .then((v) => {
      e.reading = false;
      if (e.gen === began) publish(e, v); // a change made since the read began wins over the read
      release(orgId, e);
    });
}

/** The org's «원격 제어» as this page knows it (null: not known · not an org person) and the way to replace it after a change. */
export function useOrgRemoteControl(orgId: string | null | undefined): [OrgRemoteControl | null, (next: OrgRemoteControl) => void] {
  const subscribe = useCallback((onChange: () => void) => {
    if (!orgId) return () => {};
    const e = entry(orgId);
    e.listeners.add(onChange);
    return () => {
      e.listeners.delete(onChange);
      release(orgId, e);
    };
  }, [orgId]);
  const value = useSyncExternalStore(subscribe, () => (orgId ? entries.get(orgId)?.value ?? null : null), () => null);
  useEffect(() => { if (orgId) read(orgId); }, [orgId]);
  const set = useCallback((next: OrgRemoteControl) => {
    if (!orgId) return;
    const e = entry(orgId);
    e.gen += 1;
    publish(e, next);
  }, [orgId]);
  return [value, set];
}
