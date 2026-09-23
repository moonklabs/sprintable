'use client';

import { useCallback, useEffect, useState } from 'react';
import { fetchMe } from '@/lib/me-client';

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

export function useMe(): { me: Me | null; error: boolean; retry: () => void } {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState(false);
  // story #3972 교차 PR 드리프트(유나 점검표 1c6a0ced, 항목 4) — 오류 자리에
  // 보이는 「다시 시도」가 필요해 재조회 트리거를 신설(retry는 nonce만 올린다,
  // 요청 자체는 아래 useEffect가 그대로 맡는다).
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchMe()
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
  }, [reloadNonce]);

  // 페드루 PO 선택 사항(2026-09-17 01:48Z) — 초기화를 effect가 아니라 retry() 안에서
  // 하면 eslint-disable 없이도 된다(초기 마운트는 error 기본값 false로 이미 정직).
  const retry = useCallback(() => { setError(false); setReloadNonce((n) => n + 1); }, []);

  return { me, error, retry };
}
