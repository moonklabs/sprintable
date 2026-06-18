import { describe, it, expect } from 'vitest';
import { buildLoginRedirect, safeNextPath, SESSION_EXPIRED_REASON } from './session-redirect';

describe('safeNextPath — 오픈 리다이렉트 가드 (AC3)', () => {
  it('내부 절대경로는 그대로 허용', () => {
    expect(safeNextPath('/board')).toBe('/board');
    expect(safeNextPath('/stories/123?tab=detail')).toBe('/stories/123?tab=detail');
    expect(safeNextPath(encodeURIComponent('/board?x=1'))).toBe('/board?x=1');
  });

  it('외부/프로토콜-상대/백슬래시 유도는 /inbox 로 차단', () => {
    expect(safeNextPath('//evil.com')).toBe('/inbox');
    expect(safeNextPath('https://evil.com')).toBe('/inbox');
    expect(safeNextPath('http://evil.com')).toBe('/inbox');
    expect(safeNextPath('/\\evil.com')).toBe('/inbox');
    expect(safeNextPath('javascript:alert(1)')).toBe('/inbox');
  });

  it('빈/누락/디코드 불가는 /inbox', () => {
    expect(safeNextPath(null)).toBe('/inbox');
    expect(safeNextPath(undefined)).toBe('/inbox');
    expect(safeNextPath('')).toBe('/inbox');
    expect(safeNextPath('%')).toBe('/inbox'); // decodeURIComponent throw
  });
});

describe('buildLoginRedirect (AC3)', () => {
  it('next(encode) + reason 쿼리를 붙인 /login 경로', () => {
    const r = buildLoginRedirect('/board?x=1');
    expect(r).toContain('/login?');
    expect(r).toContain(`next=${encodeURIComponent('/board?x=1')}`);
    expect(r).toContain(`reason=${SESSION_EXPIRED_REASON}`);
  });

  it('내부경로 아니면 /inbox 로 fallback', () => {
    expect(buildLoginRedirect('')).toContain(`next=${encodeURIComponent('/inbox')}`);
  });
});
