'use client';

import { useEffect, useState } from 'react';
import { fetchWithAuth } from '@/lib/db/client';

/**
 * story #3964 CHANGES-2(페드루 PO ②, 2026-09-16 16:15Z) — 「보류」는 admin/owner에게만
 * 보이고(비-admin은 숨김, 비활성 아님) 나머지는 안 보여야 한다. `/today`는 무거운
 * `(authenticated)` 레이아웃 밖(#3962 확定 — 가벼운 셸)이라 org role을 아직 안 갖고
 * 있다 — 그 3콜 레이아웃 전체를 끌어오는 대신, `(authenticated)/layout.tsx`가 이미
 * 쓰는 `GET /api/me`(단일 호출, `me.role`) 하나만 이 화면 전용으로 더 부른다.
 */
export function useMyOrgRole(): 'owner' | 'admin' | 'member' | null {
  const [role, setRole] = useState<'owner' | 'admin' | 'member' | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchWithAuth('/api/me')
      .then((res) => (res.ok ? res.json() : null))
      .then((json: { data?: { role?: string } } | null) => {
        if (cancelled) return;
        const r = json?.data?.role;
        setRole(r === 'owner' || r === 'admin' ? r : 'member');
      })
      .catch(() => { if (!cancelled) setRole('member'); });
    return () => { cancelled = true; };
  }, []);

  return role;
}
