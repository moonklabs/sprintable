'use client';

import { useCallback, useEffect, useState } from 'react';
import { EntitySummaryError } from '@/components/chat/embed-card';

/**
 * story 5034 (C4) — one read for ONE card, for THE VIEWER: `hidden` = the server said «not found» (403 · 404 — a thing that is not there and a thing that is not theirs look the same) ·
 * `error` = anything else (worth a «try again»). The answer is kept WITH the read it belongs to, so «loading» is derived (a different card or a retry has no answer yet) — nothing sets state
 * synchronously inside the effect. `load` must be stable per `key` (the caller builds it from what the key names).
 */
export type CardReadState<T> = { state: 'loading' } | { state: 'ready'; value: T } | { state: 'hidden' } | { state: 'error' };

export function useCardRead<T>(key: string, load: () => Promise<T>): { read: CardReadState<T>; retry: () => void } {
  const [attempt, setAttempt] = useState(0);
  const full = `${key}:${attempt}`;
  const [done, setDone] = useState<{ key: string; value: Exclude<CardReadState<T>, { state: 'loading' }> } | null>(null);
  useEffect(() => {
    let cancelled = false;
    load().then(
      (value) => { if (!cancelled) setDone({ key: full, value: { state: 'ready', value } }); },
      (e: unknown) => { if (!cancelled) setDone({ key: full, value: e instanceof EntitySummaryError && (e.status === 404 || e.status === 403) ? { state: 'hidden' } : { state: 'error' } }); },
    );
    return () => { cancelled = true; };
    // `load` is rebuilt every render by the caller; the key is what says whether it is the same read
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [full]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { read: done && done.key === full ? done.value : { state: 'loading' }, retry };
}
