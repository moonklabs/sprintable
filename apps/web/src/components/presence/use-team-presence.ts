'use client';

import { useCallback, useEffect, useState } from 'react';
import type { PresenceStatus } from '@/components/chat/presence-dot';
import { useSseMultiplexerContext } from '@/components/realtime-provider';
import { createReconnectBackoffState } from '@/lib/realtime/sse-reconnect-backoff';

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
 *
 * story #2078 — 플래그 ON이면 RealtimeProvider의 공유 커넥션에 'presence' 이벤트만 구독한다
 * (독립 EventSource를 안 여는). 플래그 OFF/Provider 밖이면 기존과 동일하게 자체 연결.
 *
 * story #2139 — 폴백 정책 결정(PO): 주기 폴링은 재도입하지 않는다(#2074 인스턴스 기아 교훈 —
 * 그래서 애초에 걷어낸 것). 대신 **재연결 시 1회 강제 refetch**를 추가한다 — 새 메커니즘이
 * 아니라 `use-chat-sse.ts`가 이미 쓰는 `subscribeReconnect`/`isReconnect` 패턴의 재사용이고,
 * "실시간이 죽으면 조용히 낡는" 구멍의 대부분이 연결이 끊겼다 재연결되는 구간이라 비용 대비
 * 효과가 크다(참고: `sse-reconnect-backoff.ts` 문서 — Cloud Run 60s 요청 타임아웃 때문에
 * 이 재연결 자체가 정상 운영 중 계속 반복되는 예정된 이벤트라, 부수적으로 수십초~1분 단위
 * 백스톱처럼도 작동한다). ⚠️남는 리스크: **연결은 살아있는데 특정 named 이벤트만 안 오는
 * 경우**는 이 폴백으로 못 잡는다(#2139가 정확히 이 형태 — heartbeat·연결 전부 정상인데
 * presence만 0건 관측됨). 그건 폴백이 아니라 배달 경로 자체를 일원화하는 것(#2132)이 답이다.
 */
export function useTeamPresence(active: boolean, memberId?: string): TeamPresenceItem[] {
  const [items, setItems] = useState<TeamPresenceItem[]>([]);
  const mux = useSseMultiplexerContext();

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
    if (!active || typeof window === 'undefined') return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchPresence(); // 초기 스냅샷
    const onVisible = () => { if (!document.hidden) void fetchPresence(); }; // hidden 중 누락 보정
    document.addEventListener('visibilitychange', onVisible);

    if (mux) {
      const unsubPresence = mux.subscribe('presence', () => { void fetchPresence(); });
      // story #2139 — 공유 커넥션이 끊겼다 재연결되면 그 구간에 놓쳤을 변경을 강제 refetch로 흡수.
      const unsubReconnect = mux.subscribeReconnect(() => { void fetchPresence(); });
      return () => {
        unsubPresence();
        unsubReconnect();
        document.removeEventListener('visibilitychange', onVisible);
      };
    }

    // 독립 연결 폴백(플래그 OFF 또는 Provider 밖) — story #2078 이전과 완전히 동일한 코드
    // + story #2139의 재연결 refetch(use-chat-sse.ts와 동일한 backoff.isReconnect() 패턴).
    if (typeof EventSource === 'undefined') {
      return () => document.removeEventListener('visibilitychange', onVisible);
    }
    const backoff = createReconnectBackoffState();
    const url = new URL('/api/event-stream', window.location.origin);
    if (memberId) url.searchParams.set('member_id', memberId);
    const es = new EventSource(url.toString(), { withCredentials: true });
    es.onopen = () => {
      const isReconnect = backoff.isReconnect();
      backoff.onOpen();
      if (isReconnect) void fetchPresence();
    };
    // 재연결 여부는 hadPriorError(직전 error 발생 이력)로 판정된다 — 이 훅은 수동 재시도를
    // 걸지 않고 브라우저 native auto-reconnect에 맡기지만, onError를 호출해두지 않으면
    // isReconnect()가 영원히 false로 남아 위 onopen의 refetch가 절대 안 켜진다.
    es.onerror = () => { backoff.onError(); };
    es.addEventListener('presence', () => { void fetchPresence(); }); // 변경 시 push → refetch
    return () => { es.close(); document.removeEventListener('visibilitychange', onVisible); };
  }, [active, fetchPresence, memberId, mux]);

  return items;
}
