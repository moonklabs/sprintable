'use client';

import { useEffect, useRef } from 'react';
import { useRefreshContext } from '@/contexts/refresh-context';

/**
 * 전역 RefreshContext의 인터벌에 맞춰 fn을 자동 호출합니다.
 * key는 전역에서 유일해야 하며, 언마운트 시 자동으로 해제됩니다.
 */
export function useAutoRefresh(key: string, fn: () => void) {
  const { register, unregister } = useRefreshContext();
  const fnRef = useRef(fn);

  // 매 렌더마다 최신 fn으로 ref 갱신 (stale closure 방지)
  useEffect(() => {
    fnRef.current = fn;
  });

  useEffect(() => {
    register(key, () => fnRef.current());
    return () => unregister(key);
  }, [key, register, unregister]);
}
