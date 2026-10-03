'use client';

/**
 * story #4535 (PO 18:58Z · 미르코 실측 `combined-r3/1-chip-on.png`) — one reading of the org's «원격 제어» for /desktop. The switch card
 * and «원격 기기» used to read it each on their own, once: after turning it on, «원격 기기» still said «꺼져 있어요». Now both look at
 * the same value — read once per org while someone on the page shows it, and replaced by the switch's own answer when it changes
 * (a failed change sets nothing, so neither moves). Dropped when the last one leaves, so the next visit reads it again.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { fetchWithAuth } from '@/lib/db/client';

export interface OrgRemoteControl {
  enabled: boolean;
  enabled_at: string | null;
  can_change: boolean;
}

interface Entry { value: OrgRemoteControl | null; listeners: Set<() => void>; asked: boolean }
const entries = new Map<string, Entry>();

function entry(orgId: string): Entry {
  let e = entries.get(orgId);
  if (!e) { e = { value: null, listeners: new Set(), asked: false }; entries.set(orgId, e); }
  return e;
}

function publish(orgId: string, value: OrgRemoteControl | null): void {
  const e = entries.get(orgId);
  if (!e) return;
  e.value = value;
  for (const l of e.listeners) l();
}

function read(orgId: string): void {
  const e = entry(orgId);
  if (e.asked) return;
  e.asked = true;
  void fetchWithAuth(`/api/organizations/${orgId}/remote-control`)
    .then(async (res) => (res.ok ? ((await res.json()) as { data?: OrgRemoteControl }).data ?? null : null))
    .catch(() => null)
    .then((v) => publish(orgId, v));
}

/** The org's «원격 제어» as this page knows it (null: not known · not an org person) and the way to replace it after a change. */
export function useOrgRemoteControl(orgId: string | null | undefined): [OrgRemoteControl | null, (next: OrgRemoteControl) => void] {
  const subscribe = useCallback((onChange: () => void) => {
    if (!orgId) return () => {};
    const e = entry(orgId);
    e.listeners.add(onChange);
    return () => {
      e.listeners.delete(onChange);
      if (e.listeners.size === 0) entries.delete(orgId);
    };
  }, [orgId]);
  const value = useSyncExternalStore(subscribe, () => (orgId ? entries.get(orgId)?.value ?? null : null), () => null);
  useEffect(() => { if (orgId) read(orgId); }, [orgId]);
  const set = useCallback((next: OrgRemoteControl) => { if (orgId) publish(orgId, next); }, [orgId]);
  return [value, set];
}
