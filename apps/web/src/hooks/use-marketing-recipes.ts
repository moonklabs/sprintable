'use client';

import { useCallback, useEffect, useState } from 'react';
import { fetchWithAuth } from '@/lib/db/client';
import type { EventDefinitionResponse } from '@/components/loops/loop-create-dialog';
import { recipeKeyDomain } from '@/lib/recipe-role-slots';

// story #4046(E-RECIPE-1 ①) — «마케팅 레시피 갤러리»의 데이터 층. list_event_definitions
// (GET /api/events/definitions, story #2634 — 이미 존재하는 완성 엔드포인트, 이 카드가 새로
// 배선하는 게 아니다)를 그대로 호출하고, key.split('.')[1]==='marketing'인 것만 남긴다(#4039
// PR 설계정정이 명시한 그 축 — recipeKeyDomain 재사용, FE가 새 필터 파라미터를 서버에 요구하지
// 않는다). 개발 워크플로(preset.workflow.*)·org 커스텀 정의(preset. 접두 없음)는 여기서 안
// 걸러 workflow-template-gallery-section.tsx·organization/events/page.tsx가 이미 하는 일과
// 안 겹친다.
//
// 프레젠테이션(레이아웃·픽셀)은 유나 시안(#4038) 확定 후 후속 카드 — 이 훅은 타입·목록·로딩/
// 에러 상태까지만 내준다.

const MARKETING_DOMAIN = 'marketing';
const EVENTS_DEFINITIONS_API_PATH = '/api/events/definitions';

export interface UseMarketingRecipesResult {
  recipes: EventDefinitionResponse[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function isMarketingRecipeKey(key: string): boolean {
  return recipeKeyDomain(key) === MARKETING_DOMAIN;
}

export function useMarketingRecipes(): UseMarketingRecipesResult {
  const [recipes, setRecipes] = useState<EventDefinitionResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const res = await fetchWithAuth(EVENTS_DEFINITIONS_API_PATH);
        if (!res.ok) throw new Error(`status ${res.status}`);
        // events/page.tsx와 동일 방어적 unwrap — BE는 배열 그대로 주지만(list_event_definitions
        // response_model=list[...]) fastapi-proxy 경유 계약이 {data:[...]}로 감싸질 가능성을
        // 같은 자리에서 이미 방어하고 있어(story #2664 주석) 그 관례를 그대로 따른다.
        const json = (await res.json()) as EventDefinitionResponse[] | { data?: EventDefinitionResponse[] };
        const all = Array.isArray(json) ? json : (json.data ?? []);
        if (cancelled) return;
        setRecipes(all.filter((d) => isMarketingRecipeKey(d.key)));
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'failed to load recipes');
        setRecipes([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [nonce]);

  return { recipes, loading, error, refresh };
}
