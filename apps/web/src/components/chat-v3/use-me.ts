'use client';

import { useEffect, useState } from 'react';
import { fetchWithAuth } from '@/lib/db/client';

/**
 * story #3972 — `/chat`은 `/today`(#3962)와 같은 가벼운 셸(=`(authenticated)`
 * 레이아웃 밖)이라 `currentTeamMemberId`/`projectId`를 그 레이아웃의 `useDashboardContext()`
 * 로 못 받는다. `today-v3`의 `useMyOrgRole`(#3964, `GET /api/me` 1콜)과 같은 패턴 —
 * 이 화면은 role뿐 아니라 id·projectId도 필요해 같은 콜에서 3필드 다 뽑는 버전.
 *
 * 페드루 PO CHANGES C2(2026-09-17 00:04Z, PR #4370) — `/api/me` 실패를 조용히
 * 삼키면(구 `.catch(() => {})`) 화면이 「아직 me 도착 전」과 구분 못 해 무한
 * 로딩으로 보인다 — `error` 신호를 따로 실어 호출부가 로딩/오류를 가르게 한다.
 */
export interface Me {
  id: string;
  projectId: string;
  role: 'owner' | 'admin' | 'member';
}

export function useMe(): { me: Me | null; error: boolean } {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchWithAuth('/api/me')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((json: { data?: { id?: string; project_id?: string; role?: string } }) => {
        if (cancelled) return;
        const data = json.data;
        if (!data?.id || !data.project_id) { setError(true); return; }
        const role = data.role === 'owner' || data.role === 'admin' ? data.role : 'member';
        setMe({ id: data.id, projectId: data.project_id, role });
      })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, []);

  return { me, error };
}
