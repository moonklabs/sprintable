import { describe, expect, it } from 'vitest';
import { deriveTrustStage, pickRelevantMergeGate } from './verify';

describe('deriveTrustStage (claimed-vs-verified-spec-handoff §3 파생 규칙)', () => {
  it('returns "verified" when human_verified is true (green 무결성 — human_verified가 유일한 green 조건)', () => {
    expect(deriveTrustStage({ human_verified: true, self_reported: true })).toBe('verified');
  });

  it('returns "claimed" when self_reported is true but human_verified is not', () => {
    expect(deriveTrustStage({ self_reported: true, human_verified: null })).toBe('claimed');
    expect(deriveTrustStage({ self_reported: true, human_verified: false })).toBe('claimed');
  });

  it('returns null (무표시) when self_reported is falsy — D-03 완료 기준(증거 없는 Done은 승격 불가)', () => {
    expect(deriveTrustStage({ self_reported: null, human_verified: null })).toBeNull();
    expect(deriveTrustStage({})).toBeNull();
  });

  it('never returns "claimed" when human_verified is true, even if self_reported is somehow false (verified takes precedence)', () => {
    expect(deriveTrustStage({ self_reported: false, human_verified: true })).toBe('verified');
  });
});

// story #2933 H3(P0-H 정직성 감사) — deriveInFlightTrustChip(구 in-flight 칩 gate-목록 재파생)
// 은 story-detail-panel.tsx의 유일한 소비처를 잃고 폐기됐다(story.trust_stage로 수렴, BE
// derive_trust_stage() SoT 하나만 남김). 이 describe 블록도 함께 제거 — 죽은 함수의 테스트를
// 남겨두면 "아직 쓰인다"는 착시가 생긴다.

// story #2893(설계안 §2 A1) — 스토리당 merge 게이트가 여러 개(PR마다 1개)일 수 있다.
describe('pickRelevantMergeGate (story #2893 — PR단위 게이트 중 하나를 고르는 축)', () => {
  it('non-merge gate_type은 후보에서 제외한다', () => {
    expect(pickRelevantMergeGate([{ gate_type: 'doc_approval', status: 'pending', pr_number: null }])).toBeUndefined();
  });

  it('merge 게이트가 없으면 undefined(정직 — 지어내지 않음)', () => {
    expect(pickRelevantMergeGate([])).toBeUndefined();
  });

  it('미종결(pending/auto_passed/held)이 종결(approved/rejected/voided)보다 우선', () => {
    const approved = { gate_type: 'merge', status: 'approved', pr_number: 999 };
    const pending = { gate_type: 'merge', status: 'pending', pr_number: 1 };
    expect(pickRelevantMergeGate([approved, pending])).toBe(pending);
  });

  it('동순위(둘 다 미종결)면 pr_number가 큰 쪽(최근 PR로 근사)이 우선', () => {
    const older = { gate_type: 'merge', status: 'pending', pr_number: 101 };
    const newer = { gate_type: 'merge', status: 'pending', pr_number: 102 };
    expect(pickRelevantMergeGate([older, newer])).toBe(newer);
  });

  it('pr_number가 null인 게이트는 최하순위(실 PR 정보가 있는 쪽을 우선)', () => {
    const noPr = { gate_type: 'merge', status: 'pending', pr_number: null };
    const withPr = { gate_type: 'merge', status: 'pending', pr_number: 5 };
    expect(pickRelevantMergeGate([noPr, withPr])).toBe(withPr);
  });
});
