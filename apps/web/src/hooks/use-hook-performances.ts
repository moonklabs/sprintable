'use client';

import { fetchWithAuth } from '@/lib/db/client';
import type { HookPerformanceSummary } from '@/services/material-lineage';
import { useAsyncResourceBatch } from './use-async-resource';

// story #4063(E-RECIPE-1 ④ 렌더, PR #4434 위) — GET /api/v2/material-lineage/hook-performance
// ?hook_key= 를 hookKeys 배열만큼 병렬 조회. 훅 하나마다 별 호출이라(BE가 배치 엔드포인트를
// 안 열었다, doc c7991109에 그런 계약 없음 — 지어내지 않는다) Promise.all로 묶는다.
const HOOK_PERFORMANCE_API_PATH = '/api/v2/material-lineage/hook-performance';

export interface UseHookPerformancesResult {
  // hook_key → summary. 실패/미조회 hook_key는 이 맵에 아예 안 들어간다(0 위장 안 함).
  summaries: Record<string, HookPerformanceSummary>;
  loading: boolean;
  loadFailed: boolean;
}

async function fetchOne(hookKey: string): Promise<HookPerformanceSummary | null> {
  try {
    const params = new URLSearchParams({ hook_key: hookKey });
    const res = await fetchWithAuth(`${HOOK_PERFORMANCE_API_PATH}?${params.toString()}`);
    if (!res.ok) return null;
    return (await res.json()) as HookPerformanceSummary;
  } catch {
    return null;
  }
}

// story #4071 마이그(useAsyncResourceBatch 위) — 이 훅의 원본 skip 조건은
// `keys.length === 0`(배열 길이, falsy-string 아님)이라 useAsyncResourceBatch의 skip
// 판정(동일하게 length===0)과 애초에 의미가 일치한다 — #4444/#4446류 null/undefined-only
// vs falsy 불일치 클래스가 이 훅엔 안 걸림(확認, 자기점검 루틴 그대로 수행). depsKey
// 정규화(JSON.stringify)·hook_key당 개별 fetchOne(null=실패)·loadFailed(전부 실패
// 시만) 계약 전부 헬퍼가 그대로 흡수한다.
export function useHookPerformances(hookKeys: string[]): UseHookPerformancesResult {
  const { itemsByKey: summaries, loading, loadFailed } = useAsyncResourceBatch<HookPerformanceSummary>(
    hookKeys, fetchOne,
  );

  return { summaries, loading, loadFailed };
}
