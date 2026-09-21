'use client';

import { fetchWithAuth } from '@/lib/db/client';
import type { MaterialLineageEdge } from '@/services/material-lineage';
import { useAsyncResource } from './use-async-resource';

// story #4063(E-RECIPE-1 ④ 렌더, PR #4434 위) — GET /api/v2/material-lineage?work_item_id=
// 페칭. #4059(useWorkItemProductionEvidence)와 같은 결: state+loading/loadFailed+refresh.
//
// story #4089(P0 핫픽스, story #3705와 동일 결함 클래스) — BE `/api/v2/...`를 직접
// 호출하면 fetchWithAuth의 401→refresh→재시도가 BFF 인증 forwarding을 안 타 refresh
// 후에도 401이 반복돼 SessionExpiredDialog가 뜬다. BFF route
// (apps/web/src/app/api/material-lineage/route.ts) 경유로 전환.
const MATERIAL_LINEAGE_API_PATH = '/api/material-lineage';

export interface UseMaterialLineageResult {
  edges: MaterialLineageEdge[];
  loading: boolean;
  loadFailed: boolean;
  refresh: () => void;
}

// story #4071 마이그(useAsyncResource 위) — 카디르 QA(#4444/#4446)가 잡은 "원본 falsy
// skip 조건(빈 문자열 포함) vs 헬퍼의 null/undefined-only skip" 불일치 클래스를 push 前
// 선제 점검 — 원본 skip 조건은 `if (!workItemId)`(falsy 전부)라 workItemId=''도 정규화
// 필요.
export function useMaterialLineage(workItemId: string | null): UseMaterialLineageResult {
  const { data: edges, loading, loadFailed, refresh } = useAsyncResource<string, MaterialLineageEdge[]>(
    workItemId || null, [],
    async (id) => {
      const params = new URLSearchParams({ work_item_id: id });
      const res = await fetchWithAuth(`${MATERIAL_LINEAGE_API_PATH}?${params.toString()}`);
      if (!res.ok) throw new Error(`status ${res.status}`);
      const json = (await res.json()) as MaterialLineageEdge[];
      return Array.isArray(json) ? json : [];
    },
  );

  return { edges, loading, loadFailed, refresh };
}
