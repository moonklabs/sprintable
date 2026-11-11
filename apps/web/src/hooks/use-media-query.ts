'use client';

import { useCallback, useSyncExternalStore } from 'react';

/**
 * story #4888 (UI-5 home) — 화면 폭이 쿼리에 맞는지(예: `(min-width: 1024px)`). 서버 · 첫 렌더는 `false`(좁음)이고 브라우저에서 바로 실제 값으로 바뀐다.
 * 홈의 «넓음 = 오른쪽 상세 열 · 좁음 = 아래에서 오르는 시트» 갈림처럼 **같은 내용을 두 군데 그리면 안 되는** 자리에서만 쓴다 — 모양만 갈리는 곳은 CSS(`lg:`)로.
 * `matchMedia`가 없는 환경(시험 · 옛 브라우저)이면 항상 `false`.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
    const list = window.matchMedia(query);
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);
  const getSnapshot = useCallback(() => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false), [query]);
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
