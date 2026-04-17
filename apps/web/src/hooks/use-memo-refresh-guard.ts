'use client';

import { useCallback, useRef } from 'react';

export function useMemoRefreshGuard() {
  const suppressUntilRef = useRef(new Map<string, number>());

  const suppress = useCallback((memoId: string, ttlMs = 2500) => {
    suppressUntilRef.current.set(memoId, Date.now() + ttlMs);
  }, []);

  const clear = useCallback((memoId: string) => {
    suppressUntilRef.current.delete(memoId);
  }, []);

  const shouldIgnore = useCallback((memoId: string) => {
    const expiresAt = suppressUntilRef.current.get(memoId);
    if (!expiresAt) return false;
    if (expiresAt <= Date.now()) {
      suppressUntilRef.current.delete(memoId);
      return false;
    }
    return true;
  }, []);

  return { clear, suppress, shouldIgnore };
}
