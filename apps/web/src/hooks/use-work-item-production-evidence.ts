'use client';

import { fetchWithAuth } from '@/lib/db/client';
import type { EvidenceItem } from '@/services/verify';
import { filterProductionWorkbenchEvidence, type ProductionWorkbenchEvidenceItem } from '@/lib/production-workbench-evidence';
import { useAsyncResource } from './use-async-resource';

// story #4041/#4046 후속(비-게이트 forward, 2026-09-18) — 제작 작업대 evidence 렌더 데이터층.
// #4046(useRecipeMemberOptions)와 같은 결: fetch·loading/error 상태까지만, 프레젠테이션은
// 유나 작업대 시안 확定 뒤 별도 카드(gates/[id] 리치 렌더 자리)가 얹는다.
//
// 기존 GET /api/evidence?work_item_id=&work_item_type=(E-VERIFY V0-S1/S2, services/verify.ts
// 계약)를 그대로 재사용 — 신규 백엔드 엔드포인트 0. 이 훅은 그 응답을 제작 작업대 5종
// kind로만 좁혀 낸다(url/pr/deploy 등 기존 evidence 축은 여기서 안 챙긴다).
const EVIDENCE_API_PATH = '/api/evidence';

export interface UseWorkItemProductionEvidenceResult {
  items: ProductionWorkbenchEvidenceItem[];
  loading: boolean;
  // useRecipeMemberOptions와 동형 축 — items가 빈 배열인 게 "진짜 0건"인지 "못 불러옴"인지
  // 갈라야 옆 문구가 정직해진다(story #3521 관례 재사용).
  loadFailed: boolean;
  refresh: () => void;
}

// story #4071 마이그(useAsyncResource 위) — 이 훅은 두 파라미터(workItemId·workItemType)
// 둘 다 있어야 조회 가능하다(원본 skip 조건 `!workItemId || !workItemType` 그대로). 헬퍼는
// key 하나만 받으므로 둘을 `"${workItemId}:${workItemType}"` 복합 문자열로 합쳐 하나가
// 없으면 key 자체가 null이 되게 한다(원본 skip 의미 그대로 보존) — fetcher 안에서 다시
// 분리해 쓴다. 문자열 key라 매 렌더 새 객체를 안 만들어 불필요한 재조회도 안 생긴다.
export function useWorkItemProductionEvidence(
  workItemId: string | null,
  workItemType: 'story' | 'task' | null,
): UseWorkItemProductionEvidenceResult {
  const key = workItemId && workItemType ? `${workItemId}:${workItemType}` : null;

  const { data: items, loading, loadFailed, refresh } = useAsyncResource<string, ProductionWorkbenchEvidenceItem[]>(
    key, [],
    async (compositeKey) => {
      const [id, type] = compositeKey.split(':') as [string, 'story' | 'task'];
      const params = new URLSearchParams({ work_item_id: id, work_item_type: type });
      const res = await fetchWithAuth(`${EVIDENCE_API_PATH}?${params.toString()}`);
      if (!res.ok) throw new Error(`status ${res.status}`);
      const json = (await res.json()) as EvidenceItem[] | { data?: EvidenceItem[] };
      const all = Array.isArray(json) ? json : (json.data ?? []);
      return filterProductionWorkbenchEvidence(all);
    },
  );

  return { items, loading, loadFailed, refresh };
}
