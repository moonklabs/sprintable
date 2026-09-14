'use client';

import { useCallback, useEffect } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

/**
 * story #3845(우패널, 페드루 PO 확定 2026-09-14 08:26Z) — 행 선택 상태를 URL `?row=`에
 * 싣는다(work-list-shell.tsx의 기존 `useWorkListFilters`와 완전히 동일한 SSOT 원칙 —
 * 뒤로가기/새로고침에서 선택이 안 사라진다. useState 로컬 상태였다면 새로고침마다
 * 초기화되는 결함 클래스, 같은 파일의 기존 주석 그대로 재적용).
 *
 * Esc = 선택 해제(전역 keydown — 패널이 열려 있을 때만 의미가 있지만, 리스너 자체는
 * 선택 유무와 무관하게 걸어 둔다: 선택이 없으면 clearSelection이 no-op이라 안전).
 */
export function useWorkListSelection(): [string | null, (rowId: string | null) => void] {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const selectedRowId = searchParams.get('row');

  const setSelectedRowId = useCallback((rowId: string | null) => {
    const params = new URLSearchParams(searchParams.toString());
    if (rowId) params.set('row', rowId); else params.delete('row');
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  }, [pathname, router, searchParams]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setSelectedRowId(null);
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [setSelectedRowId]);

  return [selectedRowId, setSelectedRowId];
}
