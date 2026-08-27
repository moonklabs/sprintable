// @vitest-environment jsdom
//
// story #3118(Sign in with Apple) AC0(선생님 확定 2026-08-26) — Apple 로그인은 iOS·macOS
// 셸에서만 노출, 웹·안드로이드는 없어야 한다. 이 테스트는 isAppleLoginEligible()의
// fail-closed 계약(신호 부재·위조는 전부 비노출)을 값으로 고정한다 — 이 함수 하나가
// 틀리면 웹/안드로이드에 Apple 버튼이 새거나(4.8 무관 노출) iOS/macOS에서 못 뜬다.
import { afterEach, describe, expect, it } from 'vitest';
import { isAppleLoginEligible } from './native-shell-bridge';

afterEach(() => {
  delete window.__SPRINTABLE_SHELL__;
});

describe('isAppleLoginEligible — story #3118 AC0 fail-closed 계약', () => {
  it('신호 자체가 없으면(전역 undefined) 비노출', () => {
    expect(isAppleLoginEligible()).toBe(false);
  });

  it('platform="ios"면 노출', () => {
    window.__SPRINTABLE_SHELL__ = { platform: 'ios' };
    expect(isAppleLoginEligible()).toBe(true);
  });

  it('platform="macos"면 노출', () => {
    window.__SPRINTABLE_SHELL__ = { platform: 'macos' };
    expect(isAppleLoginEligible()).toBe(true);
  });

  it('platform="android"면 비노출(셸이 참값을 넣어도 웹이 숨긴다)', () => {
    window.__SPRINTABLE_SHELL__ = { platform: 'android' };
    expect(isAppleLoginEligible()).toBe(false);
  });

  it('platform이 3값 밖의 임의 문자열(위조/오배선)이면 비노출', () => {
    // @ts-expect-error — 위조/오배선 시나리오를 의도적으로 재현.
    window.__SPRINTABLE_SHELL__ = { platform: 'windows' };
    expect(isAppleLoginEligible()).toBe(false);
  });

  it('전역은 있는데 platform 필드 자체가 없으면 비노출', () => {
    // @ts-expect-error — 오배선(필드 누락) 시나리오.
    window.__SPRINTABLE_SHELL__ = {};
    expect(isAppleLoginEligible()).toBe(false);
  });
});
