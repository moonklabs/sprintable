import { describe, expect, it } from 'vitest';
import { gateTypeLabel, gateTypeLabelKey } from './gate-type-label';

// story #3565(유나 §17-24 전수·페드루 PO 確定 2026-09-06) — gate_type 12종
// (기존 6 + 신규 6) 전부 사람 낱말로 뜨는지·미등재 값은 원시값이 아니라
// 일반 「게이트」로 떨어지는지.
describe('gateTypeLabel/gateTypeLabelKey — story #3565', () => {
  const t = (key: string) => {
    const map: Record<string, string> = {
      ccGateGeneric: '게이트',
      ccGateTypeQa: 'QA', ccGateTypePrReview: 'PR 리뷰', ccGateTypeMerge: '머지',
      ccGateTypeDeploy: '배포', ccGateTypeWorkflowConfigPublish: '설정 발행',
      ccGateTypeDocApproval: '문서 결재', ccGateTypeExternalPublish: '외부 발행',
      ccGateTypeLoopDecision: '루프 결정', ccGateTypeHypothesisOutcomeConfirm: '가설 판정',
      ccGateTypeArtifactCanonicalize: '정본화', ccGateTypeAgentDecisionRequest: '판단 요청',
      ccGateTypeSupportEscalationReview: '고객지원 검토',
      ccGateTypeConceptApproval: '컨셉 결재',
    };
    return map[key] ?? key;
  };

  it('⭐신규 등재 6종(external_publish 포함)이 모두 사람 낱말로 뜬다', () => {
    expect(gateTypeLabel(t, 'external_publish')).toBe('외부 발행');
    expect(gateTypeLabel(t, 'loop_decision')).toBe('루프 결정');
    expect(gateTypeLabel(t, 'hypothesis_outcome_confirm')).toBe('가설 판정');
    expect(gateTypeLabel(t, 'artifact_canonicalize')).toBe('정본화');
    expect(gateTypeLabel(t, 'agent_decision_request')).toBe('판단 요청');
    expect(gateTypeLabel(t, 'support_escalation_review')).toBe('고객지원 검토');
  });

  // story #3560(제작 작업대, 페드루 PO 確定 2026-09-06) — concept_approval 등재.
  it('⭐concept_approval이 사람 낱말 「컨셉 결재」로 뜬다(라벨 제거 시 일반 「게이트」로 떨어지면 RED — 뮤테이션)', () => {
    expect(gateTypeLabel(t, 'concept_approval')).toBe('컨셉 결재');
  });

  it('⭐미등재 값·null·undefined는 원시값이 아니라 일반 「게이트」로 떨어진다', () => {
    expect(gateTypeLabel(t, 'some_future_unknown_gate')).toBe('게이트');
    expect(gateTypeLabel(t, null)).toBe('게이트');
    expect(gateTypeLabel(t, undefined)).toBe('게이트');
    expect(gateTypeLabelKey('some_future_unknown_gate')).toBeNull();
  });
});
