'use client';

import { useCallback, useEffect, useState } from 'react';
import { EntitySummaryError, fetchEntityCardSummary } from '@/components/chat/embed-card';

/**
 * story 5034 (C4) — what an entity card shows, read for THE VIEWER (their session · the server's rules): `hidden` = the server said «not found» (403 · 404 — a thing that is not there and a thing
 * that is not theirs look the same) · `error` = anything else (a network fault · a 5xx — worth a «try again»).
 */
export type CardSummaryState =
  | { state: 'loading' }
  | { state: 'ready'; title: string | null; status: string | null }
  | { state: 'hidden' }
  | { state: 'error' };

export function useCardSummary(kind: string, ref: string): { summary: CardSummaryState; retry: () => void } {
  const [summary, setSummary] = useState<CardSummaryState>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setSummary({ state: 'loading' });
    fetchEntityCardSummary(kind, ref).then(
      (r) => { if (!cancelled) setSummary({ state: 'ready', title: r.title, status: r.status }); },
      (e: unknown) => { if (!cancelled) setSummary(e instanceof EntitySummaryError && (e.status === 404 || e.status === 403) ? { state: 'hidden' } : { state: 'error' }); },
    );
    return () => { cancelled = true; };
  }, [kind, ref, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { summary, retry };
}
