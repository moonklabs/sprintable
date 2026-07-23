'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
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
 *
 * ⚠️2026-07-23 — #2132가 오늘 배달 경로를 살리면서(BE PR#2448) presence가 "처음으로 실제로
 * 오기 시작"한다. PO 실측: 프론트 Cloud Run이 60s마다 강제로 연결을 끊어 전 접속자가 60초
 * 주기로 재연결하고, 재연결 1건마다 BE가 emit_presence 1건을 org 전원에게 push한다 — 즉 접속자
 * M명이면 클라이언트 1개가 분당 최대 M건의 'presence' 이벤트를 받을 수 있다(M명이 각자 60초
 * 주기로 재연결하며 그 각각이 전원에게 push되므로). 아래 세 가드가 이걸 감당한다:
 * ① 디바운스(300ms) — presence 이벤트는 payload 없는 경량 트리거라(trigger({})) 여러 건을
 *   한 번의 refetch로 접어도 정보 손실이 0이다. 300ms는 근접 도착한 이벤트를 한 틱으로 묶기엔
 *   충분하고, 사람이 체감하기엔 여전히 즉시로 느껴지는 값(NN/g 기준 "0.1~1s는 지연 안 느껴짐"
 *   범위 내 — 실제 변경이 뜨는 데 최대 0.3초 더 걸리는 것뿐이라 UX 저하가 아니다).
 * ② in-flight 가드 — 요청이 이미 진행 중이면 새로 안 쏘고, 끝난 뒤 "한 번 더" 필요했는지만
 *   표시해 요청 종료 즉시 재실행한다(그냥 무시하면 그 사이 도착한 최신 변경을 놓친다).
 * ③ 레이스 가드(제일 중요) — 요청마다 단조증가 시퀀스를 붙여, 응답이 왔을 때 그 요청이 여전히
 *   최신 요청인지 확認 후에만 state에 반영한다. 없으면 늦게 도착한 stale 응답이 최신 스냅샷을
 *   덮어써 **틀린 화면을 그리는** 사고가 난다(①②는 비용 문제, ③은 정확성 문제라 성격이 다르다).
 */
const PRESENCE_EVENT_DEBOUNCE_MS = 300;

export function useTeamPresence(active: boolean, memberId?: string): TeamPresenceItem[] {
  const [items, setItems] = useState<TeamPresenceItem[]>([]);
  const mux = useSseMultiplexerContext();

  const seqRef = useRef(0);
  const inFlightRef = useRef(false);
  const pendingRef = useRef(false);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // story #2139 — in-flight 가드(②) + 레이스 가드(③). 실제 네트워크 호출은 여기서만 한다.
  const fetchPresence = useCallback(async () => {
    if (typeof document !== 'undefined' && document.hidden) return;
    if (inFlightRef.current) { pendingRef.current = true; return; }
    inFlightRef.current = true;
    const mySeq = ++seqRef.current;
    try {
      const res = await fetch('/api/team-presence');
      if (!res.ok) return;
      const json = (await res.json()) as TeamPresenceItem[] | { data?: TeamPresenceItem[] };
      // 이 응답을 보낸 뒤에 더 최신 요청이 나갔다면(seqRef가 더 커졌다면) stale이므로 버린다.
      if (seqRef.current === mySeq) {
        setItems(Array.isArray(json) ? json : (json.data ?? []));
      }
    } catch {
      /* non-critical */
    } finally {
      inFlightRef.current = false;
      if (pendingRef.current) {
        pendingRef.current = false;
        void fetchPresence();
      }
    }
  }, []);

  // story #2139 — 디바운스(①). 'presence' 이벤트가 짧은 창에 몰려 도착해도 refetch는 한 번만
  // 나가게 접는다. 마운트/탭복귀/재연결 트리거는 각자 단발성 신호라 디바운스 없이 즉시 부른다 —
  // in-flight·레이스 가드는 fetchPresence 내부에서 호출자와 무관하게 항상 적용된다.
  const scheduleFetchPresence = useCallback(() => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      void fetchPresence();
    }, PRESENCE_EVENT_DEBOUNCE_MS);
  }, [fetchPresence]);

  useEffect(() => {
    if (!active || typeof window === 'undefined') return;
    void fetchPresence(); // 초기 스냅샷
    const onVisible = () => { if (!document.hidden) void fetchPresence(); }; // hidden 중 누락 보정
    document.addEventListener('visibilitychange', onVisible);

    if (mux) {
      const unsubPresence = mux.subscribe('presence', () => { scheduleFetchPresence(); });
      // story #2139 — 공유 커넥션이 끊겼다 재연결되면 그 구간에 놓쳤을 변경을 강제 refetch로 흡수.
      const unsubReconnect = mux.subscribeReconnect(() => { void fetchPresence(); });
      return () => {
        unsubPresence();
        unsubReconnect();
        document.removeEventListener('visibilitychange', onVisible);
        if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
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
    es.addEventListener('presence', () => { scheduleFetchPresence(); }); // 변경 시 push → 디바운스 후 refetch
    return () => {
      es.close();
      document.removeEventListener('visibilitychange', onVisible);
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, [active, fetchPresence, scheduleFetchPresence, memberId, mux]);

  return items;
}
