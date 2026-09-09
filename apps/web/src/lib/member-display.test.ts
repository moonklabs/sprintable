// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { memberDisplayLabel } from './member-display';

function t(key: string): string {
  const table: Record<string, string> = { memberUnnamed: '이름 없는 구성원' };
  return table[key] ?? key;
}

describe('memberDisplayLabel — story #3755', () => {
  it('name이 있으면 그대로 돌린다', () => {
    expect(memberDisplayLabel('피오', t)).toBe('피오');
  });

  it('⭐name이 null이면 t(memberUnnamed)로 폴백한다(email/id 지어내기 금지)', () => {
    expect(memberDisplayLabel(null, t)).toBe('이름 없는 구성원');
  });

  it('name이 undefined여도 같은 폴백(BE 계약이 null | undefined 둘 다일 수 있는 소비처 대응)', () => {
    expect(memberDisplayLabel(undefined, t)).toBe('이름 없는 구성원');
  });

  // ⭐되돌리면 RED — 유나 디자인 게이트 적기만②(2026-09-09). `??`(null/undefined만 폴백)
  // 로 되돌리면 빈 문자열이 그대로 통과해 화면에 빈 칸이 뜬다.
  it('⭐빈 문자열도 같은 폴백으로 묶인다(name 없다는 같은 사실 — falsy 전체를 폴백)', () => {
    expect(memberDisplayLabel('', t)).toBe('이름 없는 구성원');
  });
});
