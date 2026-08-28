'use client';

import { useEffect, type RefObject } from 'react';
import { fetchWithAuth } from '@/lib/db/client';
import type { CardState } from '@/components/chat/approval-request-card';
import type { GateItem } from '@/components/kanban/types';

/** story #5ace2e84 — 채팅 결재카드 N+1 처방. PO 실측(웜 dev): 대화 하나 진입 시
 * `GET /api/gates/{id}` 단건 호출이 최대 51발(고유 38·중복 13) 붙어 1.08s→8.56s 스팬(p50
 * 894ms·max 7,470ms)을 먹었다 — approval-request-card.tsx 인스턴스마다 독립 fetchGate()가
 * 원인. use-entity-status-batch.ts(참조 칩 「지금 상태」 배치조회, story #2262 PR②)와 동일
 * 정신 — chat-view.tsx가 로드된 메시지 창에서 approval_target.gate_id를 모아 `?ids=`
 * 배치(GET /api/gates, story #5ace2e84 BE 처방)로 한 번에 당긴다. 카드는 이 결과가 있으면
 * (loading 포함) 독립 fetchGate()를 안 태운다(approval-request-card.tsx 소비부 참고) —
 * 배치 커버 밖(예: SSE로 대화 도중 새로 도착한 카드)만 기존 개별 fetch로 자연 폴백. */
const GATE_BATCH_API_PATH = '/api/gates';
// BE list_gates ids= 과대 IN 방어(422, backend/app/routers/gates.py)와 동일 상한 — 넘으면
// chunk로 쪼갠다(콜 수는 여전히 ceil(N/200), 무제한 팬아웃으로 되돌아가지 않는다).
const GATE_IDS_BATCH_CHUNK = 200;

function collectUnrequestedGateIds(
  messages: Array<{ approval_target?: { gate_id: string } | null }>,
  alreadyRequestedIds: Set<string>,
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const msg of messages) {
    const gateId = msg.approval_target?.gate_id;
    if (!gateId || seen.has(gateId) || alreadyRequestedIds.has(gateId)) continue;
    seen.add(gateId);
    ids.push(gateId);
  }
  return ids;
}

export function useGateBatchFetch(
  messages: Array<{ approval_target?: { gate_id: string } | null }>,
  requestedIdsRef: RefObject<Set<string>>,
  setGateByKey: (updater: (prev: Record<string, CardState>) => Record<string, CardState>) => void,
) {
  useEffect(() => {
    const ids = collectUnrequestedGateIds(messages, requestedIdsRef.current);
    if (ids.length === 0) return;
    for (const id of ids) requestedIdsRef.current.add(id);

    setGateByKey((prev) => {
      const next = { ...prev };
      for (const id of ids) next[id] = { kind: 'loading' };
      return next;
    });

    let cancelled = false;
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += GATE_IDS_BATCH_CHUNK) {
      chunks.push(ids.slice(i, i + GATE_IDS_BATCH_CHUNK));
    }

    for (const chunk of chunks) {
      fetchWithAuth(`${GATE_BATCH_API_PATH}?ids=${chunk.map(encodeURIComponent).join(',')}`)
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`status ${res.status}`))))
        // BE list_gates는 배열을 그대로 반환한다(story #2054 approvals-queue.tsx의 /api/gates/inbox와
        // 동일 계약 — {data:[...]} envelope 아님, fastapi-proxy가 그대로 통과).
        .then((data: GateItem[]) => {
          if (cancelled) return;
          const byId = new Map(data.map((g) => [g.id, g]));
          setGateByKey((prev) => {
            const next = { ...prev };
            for (const id of chunk) {
              const gate = byId.get(id);
              // project 접근권이 없어 BE가 조용히 뺀 경우(story #5ace2e84 authz 필터)도 같은
              // 자리로 떨어진다 — 카드는 not-found와 동일하게 정직한 "게이트가 없다" 문구로
              // graceful degrade(존재 비노출 규율과 대칭, 새 상태 분기 0).
              next[id] = gate ? { kind: 'ready', gate } : { kind: 'not-found' };
            }
            return next;
          });
        })
        .catch(() => {
          if (cancelled) return;
          setGateByKey((prev) => {
            const next = { ...prev };
            for (const id of chunk) next[id] = { kind: 'error' };
            return next;
          });
        });
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- requestedIdsRef·setGateByKey는 부모가 안정적으로 물려주는 참조(ref·useState setter)다.
  }, [messages]);
}
