import { describe, expect, it } from 'vitest';
import { requiresDeactivateConfirm } from './agent-management-tab';

// story #2406 AC1(실사고 2026-08-01) — 확認 없이 즉시 실행되어 목록 최상단 행(다른 사람의
// 계정)이 잘못 눌려 비활성화됐다. 되돌릴 수 없는 방향(비활성화)만 확認으로 가로채고, 되돌릴
// 수 있는 방향(활성화)엔 안 붙인다(PO 설계 판단 ② — 양쪽에 붙이면 되돌릴 수 없는 쪽의 경고가
// 묽어진다).
describe('requiresDeactivateConfirm — story #2406 AC1', () => {
  it('활성 에이전트를 끄려는 시도(비활성화, 되돌릴 수 없음)는 확認이 필요하다', () => {
    expect(requiresDeactivateConfirm({ is_active: true })).toBe(true);
  });

  it('비활성 에이전트를 켜려는 시도(활성화, 되돌릴 수 있음)는 확認이 필요 없다', () => {
    expect(requiresDeactivateConfirm({ is_active: false })).toBe(false);
  });
});
