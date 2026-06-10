'use client';

import { useCallback, useEffect, useState } from 'react';
import type { PresenceStatus } from '@/components/chat/presence-dot';

// 2505d27d: 디디 #1356 `GET /api/v2/team-presence` 응답 계약(검증 완료·mismatch 0).
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

// ~3s 절충 폴(PO) — 전 유저 상시 폴이라 request 폭증 회피 + working 충분히 snappy. 단일 폴을 FAB 배지+패널 공유(중복0).
const POLL_MS = 3000;

/**
 * 2505d27d: 팀 presence 폴 — ScrollShell(전역)에서 1회 폴해 FAB working-count 배지 + 패널에 공급.
 * 배지가 패널 닫힘 상태서도 "N 작업 중"을 보여야 하므로(선생님) **패널 open 무관 상시 폴**(active 시).
 * 단 `document.hidden`(백그라운드 탭)이면 0폴(낭비 가드).
 */
export function useTeamPresence(active: boolean): TeamPresenceItem[] {
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
    if (!active) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchPresence();
    const interval = setInterval(() => { void fetchPresence(); }, POLL_MS);
    return () => clearInterval(interval);
  }, [active, fetchPresence]);

  return items;
}
