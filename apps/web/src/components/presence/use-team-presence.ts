'use client';

import { useCallback, useEffect, useState } from 'react';
import type { PresenceStatus } from '@/components/chat/presence-dot';

// 2505d27d: #1356 `GET /api/v2/team-presence` 응답 계약(검증 완료·mismatch 0).
export interface TeamPresenceItem {
  member_id: string;
  name: string;
  avatar_url?: string | null;
  agent_role?: string | null;
  runtime_type?: string | null;
  presence_status?: PresenceStatus | null;
  working: boolean;
  active_story?: { id: string; title: string; status: string } | null;
}

/**
 * 2505d27d: 팀 presence — ScrollShell(전역)에서 FAB working-count 배지 + 패널에 공급.
 * R2(da9d1781): 3s 폴 제거 → `presence` SSE 이벤트로 refetch(폴→push·~20req/min→0). 초기 1회 +
 * 이벤트 + 탭 visible 복귀 catch-up(hidden 중 누락 이벤트 보정). presence 이벤트 payload 는 trigger({})라
 * 스냅샷은 refetch 로 확보(BE 계약). `document.hidden` 이면 fetch 0(낭비 가드 유지).
 */
export function useTeamPresence(active: boolean, memberId?: string): TeamPresenceItem[] {
  const [items, setItems] = useState<TeamPresenceItem[]>([]);

  const fetchPresence = useCallback(async () => {
    if (typeof document !== 'undefined' && document.hidden) return;
    try {
      const res = await fetch('/api/team-presence');
      if (!res.ok) return;
      const json = (await res.json()) as TeamPresenceItem[] | { data?: TeamPresenceItem[] };
      setItems(Array.isArray(json) ? json : (json.data ?? []));
    } catch {
      /* non-critical */
    }
  }, []);

  useEffect(() => {
    if (!active || typeof window === 'undefined' || typeof EventSource === 'undefined') return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchPresence(); // 초기 스냅샷
    const url = new URL('/api/event-stream', window.location.origin);
    if (memberId) url.searchParams.set('member_id', memberId);
    const es = new EventSource(url.toString(), { withCredentials: true });
    es.addEventListener('presence', () => { void fetchPresence(); }); // 변경 시 push → refetch
    const onVisible = () => { if (!document.hidden) void fetchPresence(); }; // hidden 중 누락 보정
    document.addEventListener('visibilitychange', onVisible);
    return () => { es.close(); document.removeEventListener('visibilitychange', onVisible); };
  }, [active, fetchPresence, memberId]);

  return items;
}
