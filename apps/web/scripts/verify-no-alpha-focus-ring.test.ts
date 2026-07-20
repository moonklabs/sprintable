import { describe, expect, it } from 'vitest';
import { hasAlphaFocusRing } from './verify-no-alpha-focus-ring';

describe('hasAlphaFocusRing (story #2057 regression guard)', () => {
  it('flags focus:ring-primary/40', () => {
    expect(hasAlphaFocusRing('<input className="focus:outline-none focus:ring-2 focus:ring-primary/40" />')).toBe(true);
  });

  it('flags focus-visible:ring-destructive/20', () => {
    expect(hasAlphaFocusRing('<button className="focus-visible:ring-destructive/20" />')).toBe(true);
  });

  // #1957 md-breakpoint 가드가 겪은 것과 동형 구멍 방지 — 다른 variant 뒤에 체이닝돼도 잡는다.
  it('flags a chained variant (sm:focus:ring-primary/40)', () => {
    expect(hasAlphaFocusRing('<div className="sm:focus:ring-primary/40" />')).toBe(true);
  });

  it('flags alpha inside a template literal', () => {
    expect(hasAlphaFocusRing('className={`flex ${x ? "focus:ring-warning/40" : "flex"}`}')).toBe(true);
  });

  // 장식 링(카드 강조·선택 표시, #2048 lane) — 포커스 표시가 아니라 접근성 대상 아님.
  it('does not flag a bare decorative ring without focus prefix', () => {
    expect(hasAlphaFocusRing('<div className="ring-primary/40 ring-2" />')).toBe(false);
  });

  it('does not flag alpha-free focus ring (already fixed)', () => {
    expect(hasAlphaFocusRing('<input className="focus:outline-none focus:ring-2 focus:ring-primary" />')).toBe(false);
  });

  it('does not flag unrelated text', () => {
    expect(hasAlphaFocusRing('<div className="flex items-center gap-2" />')).toBe(false);
  });
});
