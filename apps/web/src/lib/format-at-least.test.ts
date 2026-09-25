import { describe, expect, it } from 'vitest';
import { formatAtLeast } from './format-at-least';

// story #4302 — 페이지로 받는 목록의 불러온 수: 더 남았으면 `+` · 다 불러왔으면 맨 수(유나 판정).
describe('formatAtLeast', () => {
  it('더 남았으면 숫자 바로 뒤 `+`', () => { expect(formatAtLeast(48, true)).toBe('48+'); });
  it('다 불러왔으면 맨 수', () => { expect(formatAtLeast(48, false)).toBe('48'); });
  it('0건이어도 더 남았으면 `0+`(빈 첫 쪽 뒤에 더 있을 수 있음)', () => { expect(formatAtLeast(0, true)).toBe('0+'); });
});
