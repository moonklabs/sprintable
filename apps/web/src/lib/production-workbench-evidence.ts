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

export interface CurrentAndHistory {
  /** "지금 승인 대상"으로 그릴 1건 — 판별 못 하면(아래 no-fiction 분기) null. 호출부는
   * null을 "승격 대상 없음"(전부 중립 표시)으로 다뤄야지, 첫/마지막 항목을 대신 승격하면
   * 안 된다(그게 이 함수가 고치는 바로 그 결함이다). */
  current: ProductionWorkbenchEvidenceItem | null;
  /** current를 제외한 나머지 — created_at 오름차순. current가 null이면 items 전체(정렬만
   * 됨)가 여기 담긴다 — 호출부가 "전부 중립 나열"로 렌더할 원자료. */
  history: ProductionWorkbenchEvidenceItem[];
}

/** story #4433 qa:changes round-3(카디르+페드루, 2026-09-19) — round-2의 "created_at
 * 최신=현재" 추정은 근본적으로 틀렸다: 새 컨셉이 막 등록돼 아직 검증 前이면, 시간상 최신인
 * evidence가 실은 새 컨셉의 것이 아니라 **구 컨셉의 pass**일 수 있어 그걸 "현재 승인 대상"
 * 으로 오도한다. #4423이 심은 `gate.neutral_facts.stage` denorm(recipe_gate_hooks.py
 * 주석의 FE 계약)을 evidence의 `payload.stage`와 **매칭**해 진짜 "지금 이 게이트가 보는
 * stage"의 산출물만 current로 승격한다 — 시간은 그 stage 안에서 재시도가 여러 건일 때만
 * (같은 stage, 다른 시각) 타이브레이커로 쓴다.
 *
 * currentStage가 없거나(비-레시피 게이트 등) 어떤 evidence도 payload.stage를 안 실었으면
 * (구 데이터·계약 미착지 구간) 매칭 신호 자체가 없다 — 이럴 땐 "그래도 뭔가 승격"하지 않고
 * current=null로 정직하게 답한다(no-fiction — 판별 못 하면 안다고 안 한다). 호출부가 이
 * 경우 전부를 중립으로 나열한다. */
export function partitionCurrentAndHistory(
  items: ProductionWorkbenchEvidenceItem[], currentStage: string | null,
): CurrentAndHistory {
  if (items.length === 0) return { current: null, history: [] };
  const sorted = [...items].sort(
    (a, b) => new Date(a.evidence.created_at).getTime() - new Date(b.evidence.created_at).getTime(),
  );
  if (currentStage) {
    const matching = sorted.filter((item) => item.evidence.payload?.['stage'] === currentStage);
    if (matching.length > 0) {
      const current = matching[matching.length - 1]!; // 같은 stage 안 재시도면 최신.
      const history = sorted.filter((item) => item !== current);
      return { current, history };
    }
  }
  return { current: null, history: sorted };
}
