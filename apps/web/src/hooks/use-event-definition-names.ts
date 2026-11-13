'use client';

import { useEffect, useState } from 'react';
import { fetchWithAuth } from '@/lib/db/client';

/**
 * story 4921 — the human NAME of an event definition by its key (the room list's and the inbox's fallback line for an event that has no sentence of its own).
 * One shared request: every consumer waits for the same promise, the answer is kept for `TTL`, a failure is remembered briefly so a failing server is not asked again by every row.
 * Not critical — without a name the fallback line says the one word «이벤트» (never a slug), so a failed read changes nothing but the wording.
 */
export const EVENT_DEFINITION_NAMES_TTL_MS = 5 * 60_000;
export const EVENT_DEFINITION_NAMES_FAILED_TTL_MS = 30_000;

// per organization: an org's own definitions carry names only that org defined — a person who switches organizations must not see the previous org's name for the same key
const cached = new Map<string, { names: Map<string, string>; expiresAt: number }>();
const inflight = new Map<string, Promise<Map<string, string>>>();
const scopeOf = (orgId: string | undefined | null) => orgId ?? '';

function fresh(scope: string): Map<string, string> | null {
  const slot = cached.get(scope);
  return slot && slot.expiresAt > Date.now() ? slot.names : null;
}

function request(scope: string): Promise<Map<string, string>> {
  const hit = fresh(scope);
  if (hit) return Promise.resolve(hit);
  const pending = inflight.get(scope);
  if (pending) return pending;
  const run = (async () => {
    const names = new Map<string, string>();
    let ttl = EVENT_DEFINITION_NAMES_FAILED_TTL_MS;
    try {
      const res = await fetchWithAuth('/api/events/definitions');
      if (res.ok) {
        const json: unknown = await res.json().catch(() => null);
        if (Array.isArray(json)) {
          for (const d of json as Array<{ key?: unknown; name?: unknown }>) {
            if (typeof d?.key === 'string' && typeof d.name === 'string' && d.name.trim()) names.set(d.key, d.name.trim());
          }
          ttl = EVENT_DEFINITION_NAMES_TTL_MS;
        }
      }
    } catch { /* not critical */ }
    cached.set(scope, { names, expiresAt: Date.now() + ttl });
    inflight.delete(scope);
    return names;
  })();
  inflight.set(scope, run);
  return run;
}

/** test seam: forget what was read (a spec that changes the answer between cases) */
export function resetEventDefinitionNames(): void {
  cached.clear();
  inflight.clear();
}

/** a lookup `key → name | undefined` for ONE organization (the names are read again when the organization changes) */
export function useEventDefinitionNames(orgId?: string | null): (eventKey: string) => string | undefined {
  const scope = scopeOf(orgId);
  const [slot, setSlot] = useState<{ scope: string; names: Map<string, string> } | null>(() => {
    const hit = fresh(scope);
    return hit ? { scope, names: hit } : null;
  });
  useEffect(() => {
    let cancelled = false;
    void request(scope).then((names) => { if (!cancelled) setSlot({ scope, names }); });
    return () => { cancelled = true; };
  }, [scope]);
  // an answer that belongs to the previous organization is not used for this one (until this one's own read arrives)
  return (eventKey: string) => (slot?.scope === scope ? slot.names.get(eventKey) : undefined);
}
