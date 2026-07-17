// story #1954(P1a-S4) — 위험도 미확定(unknown) 시 보수적 고위험 취급 정책 회귀가드.
// 오르테가군 판정(2026-07-17): unknown을 저위험 인라인 원탭 승인 경로로 흘리면 오승인 위험 —
// BE 위험도 필드가 생기기 전까지는 항상 서명 게이팅(GateSignatureApproval) 경로를 타야 한다.
import { describe, expect, it } from 'vitest';
import { deriveRiskLevel, usesSignatureFlow } from './gate-risk';
import type { GateItem } from '../kanban/types';

const BASE_GATE: GateItem = {
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
};

describe('gate-risk', () => {
  it('BE 위험도 필드 미존재 상태에서는 항상 unknown을 반환한다(추측 금지)', () => {
    expect(deriveRiskLevel(BASE_GATE)).toBe('unknown');
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
