import { describe, expect, it } from 'vitest';
import type { EvidenceItem } from '@/services/verify';
import {
  filterProductionWorkbenchEvidence, groupProductionWorkbenchEvidenceByKind, orderedPresentKinds,
  partitionCurrentAndHistory,
} from './production-workbench-evidence';

// story #4041(제작 작업대 stage 산출물 계약 v0.5, doc 3cca821b) — #4046(recipe-role-slots.ts)
// 방식 순수 함수 테스트. evidence 목록은 실 API 응답을 축소한 형(payload 필드만 이 축의
// 관심사).

function evidence(overrides: Partial<EvidenceItem> & { payload?: Record<string, unknown> | null }): EvidenceItem {
  return {
    id: 'ev-1', type: 'report', ref: 'ref-1', source: null, note: null,
    created_by: null, created_at: '2026-09-18T00:00:00Z', org_id: 'org-1',
    work_item_id: 'story-1', work_item_type: 'story',
    artifact_version_id: null, artifact_id: null, artifact_version_number: null,
    payload: null,
    ...overrides,
  };
}

describe('filterProductionWorkbenchEvidence', () => {
  it('type=report + payload.kind가 5종 중 하나인 것만 골라낸다', () => {
    const items = [
      evidence({ id: 'e1', payload: { kind: 'storyboard' } }),
      evidence({ id: 'e2', payload: { kind: 'concept_brief' } }),
      // 5종 밖(예: generation_cost) — #4041 범위 밖이라 안 챙긴다.
      evidence({ id: 'e3', payload: { kind: 'generation_cost' } }),
      // type이 report가 아니면 kind가 뭐든 제외(url·pr 등 기존 evidence 축).
      evidence({ id: 'e4', type: 'url', ref: 'https://x', payload: { kind: 'storyboard' } }),
      // payload 자체가 없으면(대부분의 일반 evidence) 제외.
      evidence({ id: 'e5', payload: null }),
    ];
    const result = filterProductionWorkbenchEvidence(items);
    expect(result.map((r) => r.evidence.id)).toEqual(['e1', 'e2']);
    expect(result.map((r) => r.kind)).toEqual(['storyboard', 'concept_brief']);
  });

  it('빈 목록이면 빈 배열(지어내지 않음)', () => {
    expect(filterProductionWorkbenchEvidence([])).toEqual([]);
  });
});

describe('groupProductionWorkbenchEvidenceByKind', () => {
  it('kind별로 묶고, 같은 kind가 여러 건이면 배열에 다 담는다(재시도 시나리오)', () => {
    const items = filterProductionWorkbenchEvidence([
      evidence({ id: 'e1', payload: { kind: 'concept_brief' } }),
      evidence({ id: 'e2', payload: { kind: 'concept_brief' } }), // 반려 후 재제출.
      evidence({ id: 'e3', payload: { kind: 'storyboard' } }),
    ]);
    const grouped = groupProductionWorkbenchEvidenceByKind(items);
    expect(grouped.concept_brief?.map((i) => i.evidence.id)).toEqual(['e1', 'e2']);
    expect(grouped.storyboard?.map((i) => i.evidence.id)).toEqual(['e3']);
  });

  it('없는 kind는 키 자체가 없다(빈 배열로 채우지 않음)', () => {
    const grouped = groupProductionWorkbenchEvidenceByKind([]);
    expect(grouped.animatic).toBeUndefined();
    expect('animatic' in grouped).toBe(false);
  });
});

describe('orderedPresentKinds', () => {
  it('#4041 §3 stage 순서(소재 수집→컨셉→스토리보드→애니매틱→검증)대로, 존재하는 kind만 낸다', () => {
    const items = filterProductionWorkbenchEvidence([
      evidence({ id: 'e1', payload: { kind: 'animatic' } }),
      evidence({ id: 'e2', payload: { kind: 'material_collection_sheet' } }),
      evidence({ id: 'e3', payload: { kind: 'concept_brief' } }),
    ]);
    const grouped = groupProductionWorkbenchEvidenceByKind(items);
    // 입력 순서(animatic·material_collection_sheet·concept_brief)와 무관하게 §3 순서로 정렬.
    expect(orderedPresentKinds(grouped)).toEqual(['material_collection_sheet', 'concept_brief', 'animatic']);
  });

  it('아무것도 없으면 빈 배열', () => {
    expect(orderedPresentKinds({})).toEqual([]);
  });
});

describe('partitionCurrentAndHistory (story #4433 qa:changes round-3 — stage 매칭, 시간축 폐기)', () => {
  it('gate.neutral_facts.stage와 payload.stage가 일치하는 evidence만 current로 승격한다', () => {
    const items = filterProductionWorkbenchEvidence([
      evidence({ id: 'e-old-concept', created_at: '2026-09-19T00:00:00Z', payload: { kind: 'verification_sheet', stage: 'concept_confirmed' } }),
      evidence({ id: 'e-new-concept', created_at: '2026-09-18T00:00:00Z', payload: { kind: 'verification_sheet', stage: 'structure_approval' } }),
    ]);
    // 시간상으론 e-old-concept가 더 최신이지만, 게이트가 지금 보는 stage는 structure_approval
    // — round-2의 "최신=현재" 추정이었다면 e-old-concept(구 컨셉 pass)가 잘못 승격됐을 자리.
    const { current, history } = partitionCurrentAndHistory(items, 'structure_approval');
    expect(current?.evidence.id).toBe('e-new-concept');
    expect(history.map((i) => i.evidence.id)).toEqual(['e-old-concept']);
  });

  it('같은 stage 안에 재시도가 여러 건이면 그 안에서만 created_at 최신을 current로(타이브레이커)', () => {
    const items = filterProductionWorkbenchEvidence([
      evidence({ id: 'e-retry-1', created_at: '2026-09-18T00:00:00Z', payload: { kind: 'verification_sheet', stage: 'concept_confirmed' } }),
      evidence({ id: 'e-retry-2', created_at: '2026-09-19T00:00:00Z', payload: { kind: 'verification_sheet', stage: 'concept_confirmed' } }),
    ]);
    const { current, history } = partitionCurrentAndHistory(items, 'concept_confirmed');
    expect(current?.evidence.id).toBe('e-retry-2');
    expect(history.map((i) => i.evidence.id)).toEqual(['e-retry-1']);
  });

  it('currentStage와 일치하는 evidence가 하나도 없으면 아무것도 승격하지 않는다(no-fiction — 모르면 안다고 안 함)', () => {
    const items = filterProductionWorkbenchEvidence([
      evidence({ id: 'e1', created_at: '2026-09-19T00:00:00Z', payload: { kind: 'verification_sheet', stage: 'concept_confirmed' } }),
    ]);
    const { current, history } = partitionCurrentAndHistory(items, 'structure_approval');
    expect(current).toBeNull();
    expect(history.map((i) => i.evidence.id)).toEqual(['e1']);
  });

  it('currentStage가 null이면(비-레시피 게이트 등) 매칭을 시도하지 않고 전부 history', () => {
    const items = filterProductionWorkbenchEvidence([evidence({ id: 'e1', payload: { kind: 'animatic', stage: 'animatic' } })]);
    const { current, history } = partitionCurrentAndHistory(items, null);
    expect(current).toBeNull();
    expect(history.map((i) => i.evidence.id)).toEqual(['e1']);
  });

  it('evidence에 payload.stage 자체가 없으면(구 데이터·계약 미착지) 매칭 불가 — 전부 history', () => {
    const items = filterProductionWorkbenchEvidence([evidence({ id: 'e1', payload: { kind: 'animatic' } })]);
    const { current, history } = partitionCurrentAndHistory(items, 'concept_confirmed');
    expect(current).toBeNull();
    expect(history.map((i) => i.evidence.id)).toEqual(['e1']);
  });

  it('빈 배열이면 current=null·history=빈 배열(지어내지 않음)', () => {
    expect(partitionCurrentAndHistory([], 'concept_confirmed')).toEqual({ current: null, history: [] });
  });
});
