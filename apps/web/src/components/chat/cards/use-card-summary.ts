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
  const [attempt, setAttempt] = useState(0);
  const key = `${kind}:${ref}:${attempt}`;
  // the answer is kept WITH the read it belongs to: a different card (or a retry) has no answer yet, so «loading» is derived — nothing sets state synchronously inside the effect
  const [done, setDone] = useState<{ key: string; value: Exclude<CardSummaryState, { state: 'loading' }> } | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchEntityCardSummary(kind, ref).then(
      (r) => { if (!cancelled) setDone({ key, value: { state: 'ready', title: r.title, status: r.status } }); },
      (e: unknown) => { if (!cancelled) setDone({ key, value: e instanceof EntitySummaryError && (e.status === 404 || e.status === 403) ? { state: 'hidden' } : { state: 'error' } }); },
    );
    return () => { cancelled = true; };
  }, [kind, ref, key]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const summary: CardSummaryState = done && done.key === key ? done.value : { state: 'loading' };
  return { summary, retry };
}
