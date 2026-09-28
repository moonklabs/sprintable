import { describe, expect, it } from 'vitest';
import { roleAccentVar } from './role-accent';

// story #4067(유나 design-QA, 2026-09-19) — role dot이 status(--success/--warning/
// --destructive) 색과 안 겹치고, positional(Object.keys 순서) 아니라 role KEY 자체로
// 안정적으로 매핑되는지 pin. 실 seed 4역할(Creator/Director/Compute/Publisher, ORDER
// 그대로)이 대상.

describe('roleAccentVar', () => {
  it('실 seed 4역할이 ORDER 순서대로 accent-1..4를 받는다(Creator/Director/Compute/Publisher)', () => {
    expect(roleAccentVar('Creator')).toBe('var(--role-accent-1)');
    expect(roleAccentVar('Director')).toBe('var(--role-accent-2)');
    expect(roleAccentVar('Compute')).toBe('var(--role-accent-3)');
    expect(roleAccentVar('Publisher')).toBe('var(--role-accent-4)');
  });

  // 핵심 회귀 — 구 ROLE_DOT_PALETTE 방식은 Object.keys(stageMetadata) 삽입 순서로 색을
  // 매겼다(recipe마다 stage_metadata 순서가 다를 수 있어 같은 role이 recipe A에선 파랑,
  // recipe B에선 빨강이 될 수 있었다). 이제는 role KEY 자체가 색을 결정하므로, 호출 순서를
  // 뒤바꿔도 각 role의 accent는 그대로다.
  it('호출 순서를 뒤바꿔도 같은 role은 항상 같은 accent를 받는다(positional 아님, 핵심 회귀)', () => {
    const forward = ['Creator', 'Director', 'Compute', 'Publisher'].map(roleAccentVar);
    const backward = ['Publisher', 'Compute', 'Director', 'Creator'].map(roleAccentVar).reverse();
    expect(forward).toEqual(backward);
  });

  it('ORDER에 없는 role(org 커스텀 등)도 매번 같은 accent로 안정 폴백한다', () => {
    const first = roleAccentVar('CustomReviewer');
    const second = roleAccentVar('CustomReviewer');
    expect(first).toBe(second);
    expect(first).toMatch(/^var\(--role-accent-[1-6]\)$/);
  });

  it('서로 다른 미등재 role은 (대개) 서로 다른 accent를 받는다 — 전부 같은 색으로 뭉개지지 않음', () => {
    const roles = ['Reviewer', 'Approver', 'Watcher', 'Escalator', 'Auditor'];
    const accents = new Set(roles.map(roleAccentVar));
    expect(accents.size).toBeGreaterThan(1);
  });

  it('결과는 항상 --role-accent-1..6 중 하나다(범위 밖 변수명 생성 안 함)', () => {
    const roles = ['Creator', 'Director', 'Compute', 'Publisher', 'X', 'ZZZZZZZZZZ', ''];
    for (const role of roles) {
      expect(roleAccentVar(role)).toMatch(/^var\(--role-accent-[1-6]\)$/);
    }
  });
});
