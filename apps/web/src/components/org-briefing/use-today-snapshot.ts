'use client';

import { useEffect, useState } from 'react';
import { fetchWithAuth } from '@/lib/db/client';
import { EMPTY_TODAY_SNAPSHOT, parseToday, type TodaySnapshot } from './derive-today';

/**
 * story #3831(오늘 v2) origin — story #3962(오늘 v3 첫 화면)가 같은 데이터층을 필요로
 * 해서 org-briefing-shell.tsx의 private 함수를 이 공유 파일로 뽑았다(새 기전 0 —
 * `/api/today` 1콜은 여기 한 곳뿐, 두 화면이 각자 fetch를 새로 짓지 않는다).
 */
export function useTodaySnapshot() {
  const [data, setData] = useState<TodaySnapshot | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoadError(false);
    fetchWithAuth('/api/today')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((json) => { if (!cancelled) setData(parseToday(json)); })
      .catch(() => { if (!cancelled) setLoadError(true); });
    return () => { cancelled = true; };
  }, [reloadNonce]);

  return { data, loadError, retry: () => setReloadNonce((n) => n + 1) };
}

export { EMPTY_TODAY_SNAPSHOT };
export type { TodaySnapshot };
