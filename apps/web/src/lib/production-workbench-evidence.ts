// story #4041(제작 작업대 — 크리에이터 에이전트 stage 산출물 계약 v0.5, doc 3cca821b) 위
// 렌더 데이터 순수 함수. #4046(recipe-role-slots.ts)과 같은 결 — 여기서 그룹/정렬만 하고
// 시각(카드·색·레이아웃)은 유나 작업대 시안 확定 뒤 별도 컴포넌트가 얹는다(이 파일은 로직 0
// 컴포넌트를 아예 만들지 않는다, no-sloppy-products).
import {
  type EvidenceItem, type ProductionWorkbenchKind, isProductionWorkbenchKind,
  PRODUCTION_WORKBENCH_KIND_ORDER,
} from '@/services/verify';

export interface ProductionWorkbenchEvidenceItem {
  evidence: EvidenceItem;
  kind: ProductionWorkbenchKind;
}

/** work-item evidence 목록에서 제작 작업대 5종(kind)만 골라낸다 — 그 외 evidence(url·pr·
 * deploy 등 기존 E-VERIFY 축)는 이 화면의 관심사가 아니다(섞어서 보여주지 않는다). */
export function filterProductionWorkbenchEvidence(items: EvidenceItem[]): ProductionWorkbenchEvidenceItem[] {
  const out: ProductionWorkbenchEvidenceItem[] = [];
  for (const evidence of items) {
    const kind = evidence.payload?.['kind'];
    if (evidence.type === 'report' && isProductionWorkbenchKind(kind)) {
      out.push({ evidence, kind });
    }
  }
  return out;
}

/** kind별로 묶는다 — 한 stage가 여러 번 재시도돼 같은 kind의 evidence가 여러 건일 수 있다
 * (예: 컨셉 반려 후 재제출). 최신순 정렬은 안 한다(evidence 배열이 이미 API 응답 순서를
 * 그대로 유지 — 정렬 기준을 이 파일이 새로 짓지 않는다, 호출부가 필요하면 created_at으로
 * 직접 정렬). 없는 kind는 키 자체를 안 만든다(빈 배열 채우지 않음 — 호출부가 in 연산자로
 * "이 kind가 아예 없다"와 "있는데 0건"을 가를 필요가 없기 때문 — 이 축엔 후자가 없다). */
export function groupProductionWorkbenchEvidenceByKind(
  items: ProductionWorkbenchEvidenceItem[],
): Partial<Record<ProductionWorkbenchKind, ProductionWorkbenchEvidenceItem[]>> {
  const out: Partial<Record<ProductionWorkbenchKind, ProductionWorkbenchEvidenceItem[]>> = {};
  for (const item of items) {
    (out[item.kind] ??= []).push(item);
  }
  return out;
}

/** #4041 §3 stage 순서(소재 수집→컨셉→스토리보드→애니매틱→검증) 그대로 정렬된 kind 목록만
 * 낸다 — 그룹에 실제로 존재하는 kind만(빈 자리를 만들지 않는다). 작업대 화면이 이 순서로
 * 섹션을 그릴 때 재사용. */
export function orderedPresentKinds(
  grouped: Partial<Record<ProductionWorkbenchKind, ProductionWorkbenchEvidenceItem[]>>,
): ProductionWorkbenchKind[] {
  return PRODUCTION_WORKBENCH_KIND_ORDER.filter((kind) => (grouped[kind]?.length ?? 0) > 0);
}
