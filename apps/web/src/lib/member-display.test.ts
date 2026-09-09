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

  it('빈 문자열은 폴백하지 않는다(BE가 "" 을 name으로 준 적은 없지만, 폴백 조건은 null/undefined만 — ?? 연산자 계약 그대로)', () => {
    expect(memberDisplayLabel('', t)).toBe('');
  });
});
