// story #1972(P1a-S4) — 위험도 UX 이원화 활성. deriveRiskLevel이 BE risk_grade를 그대로 매핑하는지,
// risk_grade 부재(구버전 응답) 시 여전히 'unknown'(보수적 고위험 안전판)으로 폴백하는지 고정.
// usesSignatureFlow 축은 story #1954 정책(오르테가군 판정, 2026-07-17) 그대로 유지 — unknown/high는
// 서명 게이팅, low만 인라인 원탭 승인.
import { describe, expect, it } from 'vitest';
import { deriveRiskLevel, usesSignatureFlow, deriveGateProofState, isDecisionGate, deriveDecisionFacts } from './gate-risk';
import type { GateItem } from '../kanban/types';

function gate(overrides: Partial<GateItem>): GateItem {
  return {
    id: 'g1',
    work_item_id: 'w1',
    work_item_type: 'story',
    gate_type: 'merge_gate',
    status: 'pending',
    resolver_id: null,
    resolved_at: null,
    resolution_note: null,
    neutral_facts: null,
    created_at: '2026-07-17T00:00:00Z',
    updated_at: '2026-07-17T00:00:00Z',
    ...overrides,
  };
}

describe('gate-risk', () => {
  it('BE risk_grade="low"를 그대로 low로 매핑한다', () => {
    expect(deriveRiskLevel(gate({ risk_grade: 'low' }))).toBe('low');
  });

  it('BE risk_grade="high"를 그대로 high로 매핑한다', () => {
    expect(deriveRiskLevel(gate({ risk_grade: 'high' }))).toBe('high');
  });

  it('risk_grade가 null이면 unknown으로 폴백한다(구버전 응답 안전판)', () => {
    expect(deriveRiskLevel(gate({ risk_grade: null }))).toBe('unknown');
  });

  it('risk_grade가 undefined(필드 자체 부재)이면 unknown으로 폴백한다', () => {
    expect(deriveRiskLevel(gate({}))).toBe('unknown');
  });

  it('unknown은 서명 게이팅 경로를 탄다(보수적 고위험 취급) — 인라인 원탭 승인 금지', () => {
    expect(usesSignatureFlow('unknown')).toBe(true);
  });

  it('high도 서명 게이팅 경로를 탄다', () => {
    expect(usesSignatureFlow('high')).toBe(true);
  });

  it('low만 인라인 원탭 승인(서명 게이팅 미적용) 경로를 탄다', () => {
    expect(usesSignatureFlow('low')).toBe(false);
  });
});

// story #2926(P0-F 잔여 fast-follow, 카디르 F2 QA LOW②) — F1/F2/F3이 각자 갖고 있던 동일
// 판정 로직(pending=amber·approved=green·그 외=red)을 단일 함수로 승격. LOW①(문구 불일치)도
// GATE_STATUS_I18N_KEYS 단일 키셋으로 닫는다.
describe('deriveGateProofState', () => {
  it('pending=amber, 통일 키(gateStatusPending)', () => {
    expect(deriveGateProofState('pending')).toEqual({ proofState: 'amber', statusKey: 'gateStatusPending' });
  });

  it('approved=green, 통일 키(gateStatusApproved)', () => {
    expect(deriveGateProofState('approved')).toEqual({ proofState: 'green', statusKey: 'gateStatusApproved' });
  });

  it('rejected=red, 통일 키(gateStatusRejected)', () => {
    expect(deriveGateProofState('rejected')).toEqual({ proofState: 'red', statusKey: 'gateStatusRejected' });
  });

  it('held=red(옛 코드도 approved만 다르게 취급 — 신규 구분 아님), 통일 키(gateStatusHeld)', () => {
    expect(deriveGateProofState('held')).toEqual({ proofState: 'red', statusKey: 'gateStatusHeld' });
  });

  it('voided=red, 통일 키(gateStatusVoided)', () => {
    expect(deriveGateProofState('voided')).toEqual({ proofState: 'red', statusKey: 'gateStatusVoided' });
  });

  it('매핑 안 된 값(신설/희귀 status)은 statusKey=null — 호출부가 원문을 그대로 보여준다(지어내지 않음)', () => {
    expect(deriveGateProofState('archived')).toEqual({ proofState: 'red', statusKey: null });
  });
});

// story #3113(실사고·선생님 2026-08-26) — 실 dev API 응답(GET /api/v2/gates/inbox, gate
// 9a78dff4) neutral_facts를 그대로 양성대조로 고정한다. work_item_summary가 null인데도
// question/assumption/options가 추출돼야 «해시뿐» 결함이 재현 안 된다.
describe('gate-risk — story #3113 결정 게이트(agent_decision_request) neutral_facts 추출', () => {
  it('isDecisionGate는 gate_type이 agent_decision_request일 때만 true', () => {
    expect(isDecisionGate(gate({ gate_type: 'agent_decision_request' }))).toBe(true);
    expect(isDecisionGate(gate({ gate_type: 'merge_gate' }))).toBe(false);
    expect(isDecisionGate(gate({ gate_type: 'doc_approval' }))).toBe(false);
  });

  it('실 dev 응답(gate 9a78dff4) 양성대조 — question/assumption/options 전부 추출된다', () => {
    const facts = deriveDecisionFacts(gate({
      gate_type: 'agent_decision_request',
      work_item_summary: null,
      neutral_facts: {
        question: 'Apple Developer Program 등록($99/년) — 등록 유형을 어느 쪽으로 하시겠는지?',
        assumption: 'PO 권고=A(Organization·뭉클랩 법인 정본 명의)',
        options: ['A) Organization 등록', 'B) Individual 등록', 'C) 보류'],
        project_id: 'p1',
      },
    }));
    expect(facts).toEqual({
      question: 'Apple Developer Program 등록($99/년) — 등록 유형을 어느 쪽으로 하시겠는지?',
      assumption: 'PO 권고=A(Organization·뭉클랩 법인 정본 명의)',
      options: ['A) Organization 등록', 'B) Individual 등록', 'C) 보류'],
    });
  });

  it('neutral_facts가 null이면 null(지어내지 않음)', () => {
    expect(deriveDecisionFacts(gate({ gate_type: 'agent_decision_request', neutral_facts: null }))).toBeNull();
  });

  it('question이 없으면(BE 미배선 예외 등) null — 호출부가 기존 title/해시 폴백으로 후퇴', () => {
    expect(deriveDecisionFacts(gate({ gate_type: 'agent_decision_request', neutral_facts: { assumption: 'x' } }))).toBeNull();
  });

  it('question이 빈 문자열/공백뿐이면 null', () => {
    expect(deriveDecisionFacts(gate({ gate_type: 'agent_decision_request', neutral_facts: { question: '   ' } }))).toBeNull();
  });

  it('assumption·options 없이 question만 있어도 값을 만든다(assumption=null·options=[])', () => {
    expect(deriveDecisionFacts(gate({ gate_type: 'agent_decision_request', neutral_facts: { question: 'Q?' } })))
      .toEqual({ question: 'Q?', assumption: null, options: [] });
  });

  it('options의 비문자열 원소는 걸러낸다(BE가 형식을 어겨도 렌더가 안 죽는다)', () => {
    const facts = deriveDecisionFacts(gate({
      gate_type: 'agent_decision_request',
      neutral_facts: { question: 'Q?', options: ['A', 42, null, 'B'] },
    }));
    expect(facts?.options).toEqual(['A', 'B']);
  });
});
