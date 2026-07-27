import { describe, expect, it } from 'vitest';
import { hasMdPrefix } from './verify-no-new-md-breakpoint';

describe('hasMdPrefix (story #1957 regression guard)', () => {
  it('flags a plain md: utility', () => {
    expect(hasMdPrefix('<div className="flex md:hidden" />')).toBe(true);
  });

  // 까심 QA 지적(2026-07-17): 화이트리스트 lead-in이 복합 variant 체인에서 md: 직전 문자가
  // `:`인 경우를 놓쳤다 — 가드 존재 목적 자체가 무력화되는 구멍이었다.
  it('flags md: chained after another variant (dark:md:hidden)', () => {
    expect(hasMdPrefix('<div className="dark:md:hidden" />')).toBe(true);
  });

  it('flags md: chained after a state variant (group-hover:md:flex)', () => {
    expect(hasMdPrefix('<div className="group-hover:md:flex" />')).toBe(true);
  });

  it('flags md: inside a template literal', () => {
    expect(hasMdPrefix('className={`flex ${x ? "md:hidden" : "flex"}`}')).toBe(true);
  });

  it('flags an arbitrary-variant-adjacent md: at string start', () => {
    expect(hasMdPrefix('"md:opacity-0"')).toBe(true);
  });

  it('does not flag a JS object property key (colon followed by space)', () => {
    // 오탐 실측: lib/parse-design-tokens.ts SM_LG_MAP, components/chat/presence-dot.tsx SIZE_CLASS
    expect(hasMdPrefix("const SIZE_CLASS = { sm: 'size-2.5', md: 'size-3' } as const;")).toBe(false);
  });

  it('does not flag "md:" as a trailing substring of a longer identifier', () => {
    expect(hasMdPrefix('const amd:never = 1;')).toBe(false);
  });

  it('does not flag unrelated text without md:', () => {
    expect(hasMdPrefix('<div className="flex lg:hidden" />')).toBe(false);
  });
});
