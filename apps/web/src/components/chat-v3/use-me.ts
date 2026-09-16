'use client';

import { useEffect, useState } from 'react';
import { fetchWithAuth } from '@/lib/db/client';

/**
 * story #3972 — `/chat`은 `/today`(#3962)와 같은 가벼운 셸(=`(authenticated)`
 * 레이아웃 밖)이라 `currentTeamMemberId`/`projectId`를 그 레이아웃의 `useDashboardContext()`
 * 로 못 받는다. `today-v3`의 `useMyOrgRole`(#3964, `GET /api/me` 1콜)과 같은 패턴 —
 * 이 화면은 role뿐 아니라 id·projectId도 필요해 같은 콜에서 3필드 다 뽑는 버전.
 */
export interface Me {
  id: string;
  projectId: string;
  role: 'owner' | 'admin' | 'member';
}

export function useMe(): Me | null {
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchWithAuth('/api/me')
      .then((res) => (res.ok ? res.json() : null))
      .then((json: { data?: { id?: string; project_id?: string; role?: string } } | null) => {
        if (cancelled) return;
        const data = json?.data;
        if (!data?.id || !data.project_id) return;
        const role = data.role === 'owner' || data.role === 'admin' ? data.role : 'member';
        setMe({ id: data.id, projectId: data.project_id, role });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  return me;
}
