// story #4061(E-RECIPE-1 ④) — #4058 계약(doc c7991109 v3) 위 순수 함수. #4046
// (recipe-role-slots.ts) 방식 그대로 — 로직만, 렌더 컴포넌트는 이 파일에 없다(시각은 유나
// 성과 화면 확定 뒤 별 카드). material_lineage API 자체가 미착지라 여기 함수들은 전부
// 「edges 배열을 받으면」으로 시작한다 — 어디서 그 배열을 fetch할지는 이 파일의 관심사가
// 아니다(fetching 훅은 story #4061 AC5로 이 카드가 명시적으로 안 만든다).
import type { DerivedKind, MaterialLineageEdge, RelationKind } from '@/services/material-lineage';
import type { MaterialCollectionSheetHook } from '@/services/verify';

export interface LineageTreeNode {
  sourceEvidenceId: string;
  /** relation_kind별로 갈라 낸다 — 마스터 하나가 플랫폼컷(9종)과 훅변주(N종)를 동시에 가질
   * 수 있어(doc §3① 다중 관계), 평면 배열보다 이 구조가 「몇 종류로 갈렸는지」를 바로 낸다.
   * 존재하지 않는 relation_kind는 키 자체를 안 만든다(groupProductionWorkbenchEvidenceByKind
   * 와 동일 관례 — 빈 배열로 안 채운다). */
  variantsByRelationKind: Partial<Record<RelationKind, MaterialLineageEdge[]>>;
}

/** 평면 edges를 source_evidence_id(마스터) 단위로 묶고, 그 안에서 relation_kind별로 다시
 * 가른다. 입력 순서·정렬은 이 함수의 관심사가 아니다(호출부가 created_at 등으로 정렬). */
export function buildLineageTree(edges: MaterialLineageEdge[]): LineageTreeNode[] {
  const bySource = new Map<string, MaterialLineageEdge[]>();
  for (const edge of edges) {
    const bucket = bySource.get(edge.source_evidence_id);
    if (bucket) bucket.push(edge);
    else bySource.set(edge.source_evidence_id, [edge]);
  }
  const nodes: LineageTreeNode[] = [];
  for (const [sourceEvidenceId, groupEdges] of bySource) {
    const variantsByRelationKind: Partial<Record<RelationKind, MaterialLineageEdge[]>> = {};
    for (const edge of groupEdges) {
      (variantsByRelationKind[edge.relation_kind] ??= []).push(edge);
    }
    nodes.push({ sourceEvidenceId, variantsByRelationKind });
  }
  return nodes;
}

/** 특정 마스터의 특정 derived row(=이 변주 자신)를 찾는다 — 계보 UI가 "지금 보는 이 발행물이
 * 어느 마스터에서 왔는지" 역방향으로 조회할 때 쓴다(트리를 다시 안 만들고 평면에서 직접 찾음
 * — 트리 순회보다 이 방향이 훨씬 흔한 조회일 것으로 보여 별도 헬퍼로 뗀다). */
export function findLineageEdgeForDerived(
  edges: MaterialLineageEdge[], derivedKind: DerivedKind, derivedId: string,
): MaterialLineageEdge | null {
  return edges.find((e) => e.derived_kind === derivedKind && e.derived_id === derivedId) ?? null;
}

/** hook_key로 lineage edge를 좁힌다 — "이 훅을 쓴 변주가 몇 개고 어디에" 질문에 직접 답한다.
 * hook_key가 null인 edge(훅 미지정 변주, 예: platform_cut 순수 화면비 변환)는 제외한다. */
export function filterLineageByHookKey(edges: MaterialLineageEdge[], hookKey: string): MaterialLineageEdge[] {
  return edges.filter((e) => e.hook_key === hookKey);
}

/** material_collection_sheet의 hooks[]를 key로 바로 찾을 수 있게 인덱싱한다 — lineage
 * edge.hook_key 하나로 그 훅의 실 문구(text)·타겟을 O(1) 조회하는 게 이 함수의 존재 이유
 * (배열 매번 find()하는 대신). 중복 key는 마지막 값이 이긴다(payload 자체 정합은 서버
 * 책임 — 여기선 지어내지 않고 그대로 반영). */
export function indexHooksByKey(hooks: MaterialCollectionSheetHook[]): Map<string, MaterialCollectionSheetHook> {
  const map = new Map<string, MaterialCollectionSheetHook>();
  for (const hook of hooks) map.set(hook.key, hook);
  return map;
}
