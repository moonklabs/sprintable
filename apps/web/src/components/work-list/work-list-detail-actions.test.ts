import { describe, expect, it } from 'vitest';
import {
  gateConversationId, primaryActionLabelKey, riskBadgeVariant, riskSentenceKey,
  type WorkListGate,
} from './work-list-detail-actions';

function gate(overrides: Partial<WorkListGate> = {}): WorkListGate {
  return {
    id: 'g1', gate_type: 'doc_approval', risk_grade: null, status: 'pending',
    work_item_id: 's1', work_item_type: 'story',
    ...overrides,
  };
}

describe('primaryActionLabelKey — 「승인」/「승인하고 서명」 갈림(today_service.py의 is_signature와 동일 SSOT)', () => {
  it('⭐전수 — gate_type/risk_grade 조합 4가지', () => {
    const cases: Array<[Partial<WorkListGate>, ReturnType<typeof primaryActionLabelKey>]> = [
      [{ gate_type: 'doc_approval', risk_grade: null }, 'actionApprove'],
      [{ gate_type: 'doc_approval', risk_grade: 'low' }, 'actionApprove'],
      [{ gate_type: 'doc_approval', risk_grade: 'high' }, 'actionApproveAndSign'],
      [{ gate_type: 'external_publish', risk_grade: null }, 'actionApproveAndSign'],
      [{ gate_type: 'external_publish', risk_grade: 'low' }, 'actionApproveAndSign'],
      [{ gate_type: 'merge', risk_grade: null }, 'actionApprove'],
      [{ gate_type: 'artifact_canonicalize', risk_grade: null }, 'actionApprove'],
    ];
    for (const [overrides, expected] of cases) {
      expect(primaryActionLabelKey(gate(overrides)), JSON.stringify(overrides)).toBe(expected);
    }
  });

  it('⭐뮤테이션 표적 확認 — gate_type만 external_publish여도(risk 무관) 서명으로 갈린다(OR 조건, AND 아님)', () => {
    expect(primaryActionLabelKey(gate({ gate_type: 'external_publish', risk_grade: null }))).toBe('actionApproveAndSign');
    expect(primaryActionLabelKey(gate({ gate_type: 'external_publish', risk_grade: 'low' }))).toBe('actionApproveAndSign');
  });
});

describe('riskSentenceKey/riskBadgeVariant — gate_type/risk에서만(PO 明示, null이면 렌더 0)', () => {
  it('risk_grade=null이면 둘 다 null(placeholder 0)', () => {
    expect(riskSentenceKey(gate({ risk_grade: null }))).toBeNull();
    expect(riskBadgeVariant(gate({ risk_grade: null }))).toBeNull();
  });

  it('risk_grade=high → destructive 뱃지+고위험 문장', () => {
    expect(riskSentenceKey(gate({ risk_grade: 'high' }))).toBe('riskSentenceHigh');
    expect(riskBadgeVariant(gate({ risk_grade: 'high' }))).toBe('destructive');
  });

  it('risk_grade=low → warning 뱃지+저위험 문장', () => {
    expect(riskSentenceKey(gate({ risk_grade: 'low' }))).toBe('riskSentenceLow');
    expect(riskBadgeVariant(gate({ risk_grade: 'low' }))).toBe('warning');
  });
});

describe('gateConversationId — 실측 갭(GateResponse/HitlRequestResponse 둘 다 conversation_id 필드 0)', () => {
  it('⭐항상 null — 「답하기」가 지금 항상 비노출인 이유를 이 함수 하나로 고정', () => {
    expect(gateConversationId(gate())).toBeNull();
    expect(gateConversationId({ id: 'anything', conversation_id: 'c1' })).toBeNull();
  });
});
