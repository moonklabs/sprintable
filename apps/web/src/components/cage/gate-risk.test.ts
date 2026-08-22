// story #1972(P1a-S4) — 위험도 UX 이원화 활성. deriveRiskLevel이 BE risk_grade를 그대로 매핑하는지,
// risk_grade 부재(구버전 응답) 시 여전히 'unknown'(보수적 고위험 안전판)으로 폴백하는지 고정.
// usesSignatureFlow 축은 story #1954 정책(오르테가군 판정, 2026-07-17) 그대로 유지 — unknown/high는
// 서명 게이팅, low만 인라인 원탭 승인.
import { describe, expect, it } from 'vitest';
import { deriveRiskLevel, usesSignatureFlow, deriveGateProofState } from './gate-risk';
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
