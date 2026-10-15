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
  /** story #4583: how many of the org's live setups are connected (a count) — the approvals line shows only with one */
  connected_setups?: number;
  /** story 4584: the old name, the same value, sent by the backend for one deploy — removed with the next deploy (card 4642) */
  connected_computers?: number;
}

/** story 4584: the count of live setups, read from the new name and — for one deploy — the old one (either backend order is safe). */
export function connectedSetupsOf(s: OrgRemoteControl): number {
  return s.connected_setups ?? s.connected_computers ?? 0;
}

/** what a page sees: the value (null until read · or when it could not be) and whether the read FAILED (after its retries) — told apart from «still reading» */
interface View { value: OrgRemoteControl | null; failed: boolean }
const LOADING: View = { value: null, failed: false };
interface Entry { view: View; listeners: Set<() => void>; asked: boolean; reading: boolean; gen: number }
const entries = new Map<string, Entry>();

function entry(orgId: string): Entry {
  let e = entries.get(orgId);
  if (!e) { e = { view: LOADING, listeners: new Set(), asked: false, reading: false, gen: 0 }; entries.set(orgId, e); }
  return e;
}

function publish(e: Entry, value: OrgRemoteControl | null, failed = false): void {
  e.view = { value, failed };
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

/**
 * story 4670 AC1 (PO dev walk 10-15 · «읽기 실패 = 행 0»): a read that did not come back for a reason that may pass — the connection
 * dropped, a 5xx, a 401 that the refresh did not mend — is asked again (a few times, a little later) while someone still shows the
 * value; before, one miss left the switch row and the end card's [켜기] gone for the whole visit, with nothing said. An answer that
 * says «no» (403 not a person of the org · 404) is final and not asked again.
 */
export const REMOTE_READ_RETRY_MS = [1500, 4000] as const;

async function readOnce(orgId: string): Promise<{ value: OrgRemoteControl | null; retry: boolean; failed: boolean }> {
  try {
    const res = await fetchWithAuth(`/api/organizations/${orgId}/remote-control`);
    if (!res.ok) return { value: null, retry: res.status >= 500 || res.status === 401, failed: true };
    const value = ((await res.json()) as { data?: OrgRemoteControl }).data ?? null;
    return { value, retry: false, failed: value === null };
  } catch {
    return { value: null, retry: true, failed: true };
  }
}

function read(orgId: string): void {
  const e = entry(orgId);
  if (e.asked) return;
  e.asked = true;
  e.reading = true;
  const began = e.gen;
  void (async () => {
    let answer = await readOnce(orgId);
    for (const wait of REMOTE_READ_RETRY_MS) {
      if (!answer.retry || e.gen !== began) break;
      await new Promise((r) => setTimeout(r, wait));
      if (e.listeners.size === 0) break; // everyone left meanwhile: no one is waiting for it
      answer = await readOnce(orgId);
    }
    e.reading = false;
    if (e.gen === began) publish(e, answer.value, answer.failed); // a change made since the read began wins over the read
    release(orgId, e);
  })();
}

/**
 * The org's «원격 제어» as this page knows it (null: not known yet · or not read), the way to replace it after a change, and — story 4670 AC1 —
 * `failed`: the read did not come back even after its retries (null + failed = «could not be read», told apart from null + not failed
 * = «still reading»; a page that must not lose a row to a failed read draws it then).
 */
export function useOrgRemoteControl(orgId: string | null | undefined): [OrgRemoteControl | null, (next: OrgRemoteControl) => void, boolean] {
  const subscribe = useCallback((onChange: () => void) => {
    if (!orgId) return () => {};
    const e = entry(orgId);
    e.listeners.add(onChange);
    return () => {
      e.listeners.delete(onChange);
      release(orgId, e);
    };
  }, [orgId]);
  const view = useSyncExternalStore(subscribe, () => (orgId ? entries.get(orgId)?.view ?? LOADING : LOADING), () => LOADING);
  useEffect(() => { if (orgId) read(orgId); }, [orgId]);
  const set = useCallback((next: OrgRemoteControl) => {
    if (!orgId) return;
    const e = entry(orgId);
    e.gen += 1;
    publish(e, next);
  }, [orgId]);
  return [view.value, set, view.failed];
}

/**
 * story 4670 — turn the org's «원격 제어» on: the one PUT (owner-only on the server — the web's `can_change` is only the page's manners).
 * `orgId` is always the caller's own org (the session's, or the id the server just returned for the org this person made) — never a
 * value read from an address. Resolves with the server's new value; a refusal or a dropped connection is `ok: false` (status kept so a
 * page can tell «not the owner» 403 from a failure).
 */
export async function putOrgRemoteControl(orgId: string): Promise<{ ok: true; data: OrgRemoteControl | null } | { ok: false; status: number; code?: string }> {
  try {
    const res = await fetchWithAuth(`/api/organizations/${orgId}/remote-control`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }),
    });
    if (!res.ok) {
      // the server's closed code (`owner_required` · `person_session_required` …) — the error envelope, or FastAPI's own `detail`
      const err = (await res.json().catch(() => null)) as { error?: { code?: unknown }; detail?: { code?: unknown } } | null;
      const code = err?.error?.code ?? err?.detail?.code;
      return { ok: false, status: res.status, ...(typeof code === 'string' ? { code } : {}) };
    }
    const body = (await res.json().catch(() => null)) as { data?: OrgRemoteControl } | null;
    return { ok: true, data: body?.data ?? null };
  } catch {
    return { ok: false, status: 0 };
  }
}

/** tests only: forget every org's value and listeners */
export function __resetOrgRemoteControlForTest(): void {
  entries.clear();
}
