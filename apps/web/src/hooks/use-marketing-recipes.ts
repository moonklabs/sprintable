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
// story #4048(E-RECIPE-1 ①) — 갤러리 컴포넌트가 마케팅 탭·개발 워크플로 탭 둘 다 같은
// GET /api/events/definitions 응답에서 도메인만 갈라 보여줘야 해서(유나 v2 AC1), fetch+필터
// 로직을 useRecipesByDomain(domain)으로 일반화했다 — useMarketingRecipes는 그 얇은 래퍼로
// 남아(#4046 소비처 무회귀) domain='marketing' 고정 호출.

const EVENTS_DEFINITIONS_API_PATH = '/api/events/definitions';

export interface UseRecipesByDomainResult {
  recipes: EventDefinitionResponse[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function isMarketingRecipeKey(key: string): boolean {
  return recipeKeyDomain(key) === 'marketing';
}

/** key.split('.')[1]===domain인 정의만 남긴다(recipeKeyDomain 재사용). domain='workflow'로
 * 부르면 개발 워크플로 프리셋만, 'marketing'이면 마케팅 레시피만 — 둘 다 같은 엔드포인트 한
 * 번 호출로 클라측 분리(서버에 새 필터 파라미터 요구 안 함, #4046 설계 그대로). */
export function useRecipesByDomain(domain: string): UseRecipesByDomainResult {
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
        setRecipes(all.filter((d) => recipeKeyDomain(d.key) === domain));
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'failed to load recipes');
        setRecipes([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [domain, nonce]);

  return { recipes, loading, error, refresh };
}

export type UseMarketingRecipesResult = UseRecipesByDomainResult;

export function useMarketingRecipes(): UseMarketingRecipesResult {
  return useRecipesByDomain('marketing');
}
