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

  // PO 지적(2026-08-02) — 「넷을 다 잡았는가」가 아니라 「이 가드의 자가 어디까지인가」를
  // 심어서 재는 것. 세 우회 형태를 실제로 넣어 봤다 — 결과는 아래 두 it()에서 보듯 갈린다.
  describe('known evasions (PO-requested probe, 2026-08-02) — documents the guard\'s actual reach, not a spec to widen blindly', () => {
    // req.url 단축형은 이미 (?:request|req) 대체로 잡힌다 — 새 우회가 아니라 기존 커버리지 재확認.
    it('DOES catch req.url (short param name) — already covered, not a gap', () => {
      expect(hasRequestUrlAsBase('const url = new URL(target, req.url);')).toBe(true);
    });

    // ⚠️알려진 미탐(未探) — 변수를 한 번 거치면 정규식이 이 줄 안에서 request.url 문자열을 못 본다.
    it('MISSES variable indirection (const base = request.url; new URL(x, base)) — known gap, not caught', () => {
      const code = "const base = request.url; const url = new URL(target, base);";
      expect(hasRequestUrlAsBase(code)).toBe(false);
    });

    // ⚠️알려진 미탐(未探) — 대괄호 접근은 `.url` 리터럴이 아니라 정규식이 못 본다.
    it("MISSES bracket-notation access (new URL(x, request['url'])) — known gap, not caught", () => {
      const code = "const url = new URL(target, request['url']);";
      expect(hasRequestUrlAsBase(code)).toBe(false);
    });
  });
});
