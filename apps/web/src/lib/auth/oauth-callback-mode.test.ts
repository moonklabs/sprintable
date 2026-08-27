// story #3121 AC1 — lib/auth/oauth-callback-mode 순수함수 단위테스트. BE
// backend/app/routers/auth_firebase_internal.py의 _expected_return_uri()와 값이 반드시
// 같아야 하는 고정 매핑(둘 다 수동으로 맞춰 유지 — 자동 대조 불가, 값 바뀌면 여기·BE·모바일
// App.js OAUTH_RETURN_SCHEME_URL 셋 다 같이 고쳐야 한다).
import { describe, expect, it } from 'vitest';
import { expectedReturnUri, isOAuthCallbackMode } from './oauth-callback-mode';

describe('isOAuthCallbackMode', () => {
  it('accepts https and custom_scheme', () => {
    expect(isOAuthCallbackMode('https')).toBe(true);
    expect(isOAuthCallbackMode('custom_scheme')).toBe(true);
  });

  it('rejects anything else, including null/undefined/empty', () => {
    expect(isOAuthCallbackMode('android')).toBe(false);
    expect(isOAuthCallbackMode('')).toBe(false);
    expect(isOAuthCallbackMode(null)).toBe(false);
    expect(isOAuthCallbackMode(undefined)).toBe(false);
    expect(isOAuthCallbackMode('HTTPS')).toBe(false); // 대소문자 무관용(exact) — BE Literal과 동형
  });
});

describe('expectedReturnUri', () => {
  it('https: appLinkOrigin + /native/oauth-return', () => {
    expect(expectedReturnUri('https', 'https://dev-app.sprintable.ai')).toBe(
      'https://dev-app.sprintable.ai/native/oauth-return',
    );
    expect(expectedReturnUri('https', 'https://app.sprintable.ai')).toBe(
      'https://app.sprintable.ai/native/oauth-return',
    );
  });

  it('custom_scheme: fixed ai.sprintable URI regardless of appLinkOrigin (single slash, RFC 8252 opaque)', () => {
    expect(expectedReturnUri('custom_scheme', 'https://dev-app.sprintable.ai')).toBe('ai.sprintable:/oauth-return');
    expect(expectedReturnUri('custom_scheme', 'https://app.sprintable.ai')).toBe('ai.sprintable:/oauth-return');
  });

  // 자기검증 — 두 모드가 실제로 다른 문자열을 낸다(항상 같은 값을 반환하는 죽은 분기 방지).
  it('mut: https and custom_scheme produce different values for the same origin', () => {
    const a = expectedReturnUri('https', 'https://dev-app.sprintable.ai');
    const b = expectedReturnUri('custom_scheme', 'https://dev-app.sprintable.ai');
    expect(a).not.toBe(b);
  });
});
