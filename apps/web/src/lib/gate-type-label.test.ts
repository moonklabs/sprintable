import { describe, expect, it } from 'vitest';
import { GATE_CLAIM_GROUPS, GATE_TYPE_LABEL_KEYS, gateClaimGroup, gateClaimLabel, gateTypeLabel, gateTypeLabelKey } from './gate-type-label';

// story #4558(유나 AC0 정본 §2 · 2026-10-07) — 게이트 머리 눈썹 글은 gate_type → 세 묶음. 판단 요청 넷은 «에이전트 질문 · 판단을
// 기다려요», 진행 승인 여섯은 «진행 승인 · …»(external_publish만 «발행 승인 · …» 유지), 완료 주장 여섯은 기본값, 맵 밖은 «완료» 단정 없이
// 진행 승인 글. 묶음 표를 지우거나 기본값을 «완료 주장»으로 되돌리면 RED. (t = 키를 그대로 돌려주는 번역자 — 어느 키를 불렀는지 본다)
describe('gateClaimLabel — story #4558 눈썹 세 묶음', () => {
  const key = (k: string) => k;

  it('판단 요청 넷 → claim.decisionRequestLabel', () => {
    for (const type of ['agent_decision_request', 'loop_decision', 'hypothesis_outcome_confirm', 'support_escalation_review']) {
      expect(gateClaimGroup(type)).toBe('decision_request');
      expect(gateClaimLabel(key, type)).toBe('claim.decisionRequestLabel');
    }
  });

  it('완료 주장 여섯 → claim.label(지금 기본값 그대로)', () => {
    for (const type of ['qa', 'pr_review', 'merge', 'doc_approval', 'concept_approval', 'artifact_canonicalize']) {
      expect(gateClaimGroup(type)).toBe('claim');
      expect(gateClaimLabel(key, type)).toBe('claim.label');
    }
  });

  it('진행 승인 여섯 → claim.goAheadLabel · external_publish만 claim.publishApprovalLabel(story #4336 낱말 유지)', () => {
    for (const type of ['newsletter_send', 'ads_boost', 'generation_budget', 'deploy', 'workflow_config_publish']) {
      expect(gateClaimGroup(type)).toBe('go_ahead');
      expect(gateClaimLabel(key, type)).toBe('claim.goAheadLabel');
    }
    expect(gateClaimGroup('external_publish')).toBe('go_ahead');
    expect(gateClaimLabel(key, 'external_publish')).toBe('claim.publishApprovalLabel');
  });

  it('맵 밖 값 · null · undefined는 «완료했다고 말해요»(claim.label)가 아니라 진행 승인 글', () => {
    for (const type of ['some_future_unknown_gate', 'merge_gate', null, undefined]) {
      expect(gateClaimLabel(key, type)).toBe('claim.goAheadLabel');
      expect(gateClaimLabel(key, type)).not.toBe('claim.label');
    }
  });

  it('묶음 표의 종류 집합 == 사람 낱말 표(GATE_TYPE_LABEL_KEYS)의 종류 집합 — 새 gate_type을 한쪽에만 더하면 RED', () => {
    expect(Object.keys(GATE_CLAIM_GROUPS).sort()).toEqual(Object.keys(GATE_TYPE_LABEL_KEYS).sort());
  });
});

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
      ccGateTypeAdsBoost: '홍보',
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

  // story #3806(Phase3·3-2 PR5, 유나 §절 2026-09-11) — ads_boost 등재.
  it('⭐ads_boost가 사람 낱말 「홍보」로 뜬다(원시값 "ads_boost" 노출 방지)', () => {
    expect(gateTypeLabel(t, 'ads_boost')).toBe('홍보');
  });

  it('⭐미등재 값·null·undefined는 원시값이 아니라 일반 「게이트」로 떨어진다', () => {
    expect(gateTypeLabel(t, 'some_future_unknown_gate')).toBe('게이트');
    expect(gateTypeLabel(t, null)).toBe('게이트');
    expect(gateTypeLabel(t, undefined)).toBe('게이트');
    expect(gateTypeLabelKey('some_future_unknown_gate')).toBeNull();
  });
});
