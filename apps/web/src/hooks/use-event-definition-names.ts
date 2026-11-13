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

let cached: { names: Map<string, string>; expiresAt: number } | null = null;
let inflight: Promise<Map<string, string>> | null = null;

function request(): Promise<Map<string, string>> {
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.names);
  if (inflight) return inflight;
  inflight = (async () => {
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
    cached = { names, expiresAt: Date.now() + ttl };
    inflight = null;
    return names;
  })();
  return inflight;
}

/** test seam: forget what was read (a spec that changes the answer between cases) */
export function resetEventDefinitionNames(): void {
  cached = null;
  inflight = null;
}

/** a lookup `key → name | undefined`; stable per answer, so a consumer may list it in a dependency array */
export function useEventDefinitionNames(): (eventKey: string) => string | undefined {
  const [names, setNames] = useState<Map<string, string> | null>(() => (cached && cached.expiresAt > Date.now() ? cached.names : null));
  useEffect(() => {
    let cancelled = false;
    void request().then((n) => { if (!cancelled) setNames(n); });
    return () => { cancelled = true; };
  }, []);
  return (eventKey: string) => names?.get(eventKey);
}
