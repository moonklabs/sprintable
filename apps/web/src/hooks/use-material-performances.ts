'use client';

import { fetchWithAuth } from '@/lib/db/client';
import type { MaterialPerformanceSnapshot } from '@/services/material-lineage';
import { useAsyncResourceBatch } from './use-async-resource';

// story #4063 후속(PR 9dd179582 위) — GET /api/v2/material-lineage/material-performance
// ?derived_id= 를 derivedIds 배열만큼 병렬 조회(useHookPerformances와 동형 — BE가 배치
// 엔드포인트를 안 열었다). channel_post_draft(발행 前) 변주·org 밖 id는 API가 빈 배열로
// 답한다(에러 아님) — 그 케이스는 실패가 아니라 "정직하게 0건"이라 맵에 빈 배열로 남는다.
//
// story #4089(P0 핫픽스) — use-material-lineage.ts와 동일 결함 클래스(BFF route 없이
// BE `/api/v2/...` 직접 호출 → false SessionExpiredDialog). BFF route
// (apps/web/src/app/api/material-lineage/material-performance/route.ts) 경유로 전환.
const MATERIAL_PERFORMANCE_API_PATH = '/api/material-lineage/material-performance';

export interface UseMaterialPerformancesResult {
  // derived_id → snapshots(성공 시 빈 배열도 포함 — 미발행/무성과와 실패를 구분).
  snapshotsByDerivedId: Record<string, MaterialPerformanceSnapshot[]>;
  loading: boolean;
  loadFailed: boolean;
}

async function fetchOne(derivedId: string): Promise<MaterialPerformanceSnapshot[] | null> {
  try {
    const params = new URLSearchParams({ derived_id: derivedId });
    const res = await fetchWithAuth(`${MATERIAL_PERFORMANCE_API_PATH}?${params.toString()}`);
    if (!res.ok) return null;
    return (await res.json()) as MaterialPerformanceSnapshot[];
  } catch {
    return null;
  }
}

// story #4071 마이그(useAsyncResourceBatch 위) — 원본 skip 조건은 `ids.length === 0`
// (배열 길이 기준)이라 헬퍼의 skip 판정(동일하게 length===0)과 처음부터 일치 —
// #4444/#4446류 null/undefined-only vs falsy 불일치 클래스 대상 아님(확認).
//
// ⚠️부수 fix — 원본 depsKey는 `[...ids].sort().join(' ')`(공백 구분자)였다.
// derived_id는 FK 없는 서버 원문 필드(hook_key와 동형 축, services/material-lineage.ts
// §3① 주석)라 임의 문자열(공백 포함 가능)일 수 있다 — #4436/#4437 round-2에서
// hookKeysDepsKey가 같은 구분자로 겪은 정확히 그 클래스(join·split 왕복 오분할)가 이
// 훅에도 있었다(revert-confirm으로 실제 재현 — derivedIds=['id a'](공백 포함 단일
// id)를 원본 방식대로 넣으면 fetch가 2번(엉뚱한 'id'·'a'로 오분할) 나감을 확認 후
// 헬퍼 적용으로 1번만 나가는 것으로 복원). 헬퍼의 keysDepsKey(JSON.stringify 기반,
// split 없이 원본 배열 그대로 파싱)로 그 클래스 자체가 사라진다.
export function useMaterialPerformances(derivedIds: string[]): UseMaterialPerformancesResult {
  const { itemsByKey: snapshotsByDerivedId, loading, loadFailed } = useAsyncResourceBatch<MaterialPerformanceSnapshot[]>(
    derivedIds, fetchOne,
  );

  return { snapshotsByDerivedId, loading, loadFailed };
}
