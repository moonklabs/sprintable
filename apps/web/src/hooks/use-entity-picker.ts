'use client';

import { useEffect, useState } from 'react';
import { applyEntity, entityTypeLabel, groupEntitiesByType, type EntityResult } from '@/components/chat/chat-input-entity-tokens';
import { fetchWithAuth } from '@/lib/db/client';

/**
 * story #2263 BE 계약②(PR#2615) — FastAPI `/api/v2/entities/search`가 flat list에서
 * `{data, types}`로 바뀌었다. 이 fetch는 Next.js route(`app/api/entities/search/route.ts`)의
 * `apiSuccess(data)`를 한 겹 더 거친다 — 즉 이 hook이 받는 json은 항상
 * `{data: <FastAPI 원본 바디>, error, meta}`다.
 * ⛔예전 코드(`Array.isArray(json) ? json : (json.data ?? [])`)는 이 바깥 겹만 벗겨서 FastAPI가
 * flat list이던 시절엔 우연히 맞았지만, `{data,types}`로 바뀐 뒤엔 `json.data`가 배열이 아니라
 * `{data,types}` 객체가 되어 최종 결과가 매번 빈 배열로 떨어진다(검색 결과가 조용히 0건이 되는
 * 회귀 — Next.js route 코드 추적 + 실제 응답 형상 대조로 확認). 안쪽 겹을 한 번 더 벗겨 두 모양
 * (과거 flat list · 현재 `{data,types}`) 다 받는다.
 */
export function parseEntitySearchResults(json: unknown): EntityResult[] {
  const outer = Array.isArray(json) ? json : ((json as { data?: unknown } | null)?.data ?? json);
  const arr = Array.isArray(outer) ? outer : ((outer as { data?: EntityResult[] } | null)?.data ?? []);
  return Array.isArray(arr) ? arr : [];
}

/**
 * story #2264(C-6) — `#` 엔티티 피커의 상태·검색·토큰조립을 채팅(chat-input.tsx)에서 뽑아낸
 * 재사용 hook. AC3(새 자리 비용 = 설정 한 줄) 판정의 핵심: 이 파일이 «참조 코어»고, 새 자리를
 * 여는 것은 이 hook을 부르고 렌더 3~4줄을 붙이는 것뿐이어야 한다.
 *
 * 스코프: `#` 트리거·후보 검색·토큰조립(applyEntity)·키보드nav만 담당한다. `@`멘션·`/`커맨드는
 * 채팅 전용 개념이라 이 hook 밖(ChatInput이 계속 소유)이다 — story 본문/AC엔 그 둘이 없다.
 */
export function useEntityPicker(projectId: string | undefined) {
  const [entityQuery, setEntityQuery] = useState<string | null>(null);
  const [entityResults, setEntityResults] = useState<EntityResult[]>([]);
  const [entityIndex, setEntityIndex] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // ⛔entityQuery가 null로 바뀌는 유일한 경로는 close()/selectAndApply()인데 그 둘 다 이미
    // entityResults를 직접 비운다 — 여기서 또 setState하면 react-hooks/set-state-in-effect가
    // 막는 "effect 안 동기 setState" 패턴이 된다(#2299에서 만난 같은 규율). 그래서 이 분기는
    // fetch를 안 거는 것으로 충분하고, 결과 초기화 책임은 호출부(close 등)에 둔다.
    if (entityQuery === null || !projectId) return;
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ project_id: projectId });
      if (entityQuery) params.set('q', entityQuery);
      fetchWithAuth(`/api/entities/search?${params}`)
        .then((r) => r.json())
        .then((json: unknown) => {
          if (cancelled) return;
          setEntityResults(groupEntitiesByType(parseEntitySearchResults(json)));
          setEntityIndex(0);
        })
        .catch(() => {});
    }, 200);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [entityQuery, projectId]);

  return {
    entityQuery,
    entityResults,
    entityIndex,
    /** 입력 텍스트가 `#쿼리`로 바뀔 때마다 호출 — null이면 피커를 닫는다. */
    setEntityQuery,
    close: () => { setEntityQuery(null); setEntityResults([]); },
    moveDown: () => setEntityIndex((i) => (entityResults.length ? (i + 1) % entityResults.length : 0)),
    moveUp: () => setEntityIndex((i) => (entityResults.length ? (i - 1 + entityResults.length) % entityResults.length : 0)),
    /** 선택 결과 텍스트/caret을 돌려주고 피커를 닫는다 — text state 반영·refocus는 호출부 책임
     * (호출부마다 textarea ref가 다르므로 hook이 DOM을 직접 만지지 않는다). */
    selectAndApply(entity: EntityResult, value: string, cursorPos: number): { text: string; caretPos: number } {
      const result = applyEntity(value, cursorPos, entity.title, entity.entity_type, entity.entity_id);
      setEntityQuery(null);
      setEntityResults([]);
      return result;
    },
  };
}

export { entityTypeLabel, groupEntitiesByType, type EntityResult };
