import { describe, expect, it } from 'vitest';
import { hasRequestUrlAsBase } from './verify-no-request-url-as-base';

describe('hasRequestUrlAsBase (story #1933 regression guard)', () => {
  it('flags new URL(target, request.url)', () => {
    expect(hasRequestUrlAsBase("const res = NextResponse.redirect(new URL(target, request.url), 303);")).toBe(true);
  });

  it('flags new URL(literal path, request.url)', () => {
    expect(hasRequestUrlAsBase("const url = new URL('/internal-dogfood', request.url);")).toBe(true);
  });

  it('flags req.url (short param name variant)', () => {
    expect(hasRequestUrlAsBase("const url = new URL(target, req.url);")).toBe(true);
  });

  // 안전 패턴 — 자기 자신의 query만 읽는 단일 인자 폼은 밖으로 새는 base가 아니다.
  it('does not flag single-argument new URL(request.url) (query parsing, not a base)', () => {
    expect(hasRequestUrlAsBase('const { searchParams } = new URL(request.url);')).toBe(false);
  });

  it('does not flag the fixed pattern (resolveAppUrl(null) as base)', () => {
    expect(hasRequestUrlAsBase('const res = NextResponse.redirect(new URL(target, resolveAppUrl(null)), 303);')).toBe(false);
  });

  it('does not flag unrelated new URL() calls', () => {
    expect(hasRequestUrlAsBase("const url = new URL('https://example.com/path', 'https://example.com');")).toBe(false);
  });
});
