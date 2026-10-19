// @vitest-environment jsdom
//
// story #3118(Sign in with Apple) AC0(선생님 확定 2026-08-26) — Apple 로그인은 iOS·macOS
// 셸에서만 노출, 웹·안드로이드는 없어야 한다. 이 테스트는 isAppleLoginEligible()의
// fail-closed 계약(신호 부재·위조는 전부 비노출)을 값으로 고정한다 — 이 함수 하나가
// 틀리면 웹/안드로이드에 Apple 버튼이 새거나(4.8 무관 노출) iOS/macOS에서 못 뜬다.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isAppleLoginEligible, notifySessionChanged, readPushRegisterFailure, requestPushRetry, subscribePushRegister, isPushRetryPending, PUSH_REGISTER_EVENT } from './native-shell-bridge';

afterEach(() => {
  window.dispatchEvent(new CustomEvent(PUSH_REGISTER_EVENT)); // ends a «registering…» a test left behind
  delete window.__SPRINTABLE_SHELL__;
  delete window.ReactNativeWebView;
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

// story #3302(#2459 진단 (c) 갈래, AC4) — 셸 수신 계약(sprintable-mobile App.js:798
// `JSON.parse(msg)?.type === 'session-changed'`)과 바이트 일치해야 한다. 셸이 `type` 필드만
// 보고 다른 필드는 안 본다(App.js 주석 — "값은 안 받는다, type만 본다")고 명시돼 있어 최소
// payload({type:'session-changed'})가 계약 전체다.
describe('notifySessionChanged — 웹→셸 브릿지 발신(story #3302, #2459 진단 (c))', () => {
  it('셸 안이면 정확히 {type:"session-changed"}를 1회 postMessage한다', () => {
    const postMessage = vi.fn();
    window.ReactNativeWebView = { postMessage };
    notifySessionChanged();
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith(JSON.stringify({ type: 'session-changed' }));
  });

  it('셸 밖(window.ReactNativeWebView 부재)이면 예외 없이 조용히 아무 일도 안 한다', () => {
    expect(() => notifySessionChanged()).not.toThrow();
  });
});

describe('notifyAccountChanged — story #4397 (the app re-registers its push device for the new account)', () => {
  it('posts {type: "account-changed"} inside the native shell', async () => {
    const { notifyAccountChanged } = await import('./native-shell-bridge');
    const postMessage = vi.fn();
    window.ReactNativeWebView = { postMessage };
    notifyAccountChanged();
    expect(postMessage).toHaveBeenCalledWith(JSON.stringify({ type: 'account-changed' }));
  });

  it('does nothing outside the shell', async () => {
    const { notifyAccountChanged } = await import('./native-shell-bridge');
    expect(() => notifyAccountChanged()).not.toThrow();
  });
});

// story #4694 AC2 ② — the phone's «could not register for notifications» state: closed shape, phone app only.
describe('readPushRegisterFailure — story #4694 AC2 ② (closed shape · fail closed)', () => {
  const FAILED = { state: 'failed', stage: 'device_token', cause: 'other', retried: false };
  const inShell = (pushRegister: unknown) => {
    window.ReactNativeWebView = { postMessage: vi.fn() };
    window.__SPRINTABLE_SHELL__ = { platform: 'android', pushRegister };
  };

  it('outside the native shell (a browser) it is always null — even with a forged value', () => {
    window.__SPRINTABLE_SHELL__ = { platform: 'android', pushRegister: FAILED };
    expect(readPushRegisterFailure()).toBeNull();
  });

  it('a well-formed failure in the shell is read as is', () => {
    inShell(FAILED);
    expect(readPushRegisterFailure()).toEqual(FAILED);
    inShell({ ...FAILED, stage: 'permission', cause: 'permission', retried: true });
    expect(readPushRegisterFailure()).toEqual({ state: 'failed', stage: 'permission', cause: 'permission', retried: true });
  });

  it('«ok» · no value · a wrong shape all read as nothing to show (a wrong «notifications are off» is worse than no line)', () => {
    inShell({ state: 'ok' });
    expect(readPushRegisterFailure()).toBeNull();
    inShell(undefined);
    expect(readPushRegisterFailure()).toBeNull();
    inShell({ ...FAILED, cause: 'denied' });
    expect(readPushRegisterFailure()).toBeNull();
    inShell({ ...FAILED, stage: 'nope' });
    expect(readPushRegisterFailure()).toBeNull();
    inShell({ ...FAILED, retried: 'yes' });
    expect(readPushRegisterFailure()).toBeNull();
    inShell('failed');
    expect(readPushRegisterFailure()).toBeNull();
  });

  it('the server-refused stage `register` is accepted for when the shell starts reporting it', () => {
    inShell({ ...FAILED, stage: 'register' });
    expect(readPushRegisterFailure()?.stage).toBe('register');
  });

  it('an extra field (e.g. a raw error code) is not passed on', () => {
    inShell({ ...FAILED, errorCode: 'E_REGISTRATION_FAILED' });
    expect(readPushRegisterFailure()).toEqual(FAILED);
  });
});

describe('push retry bridge — story #4694 AC2 ②', () => {
  it('requestPushRetry posts exactly one closed message (the shell reads only `type`)', () => {
    const postMessage = vi.fn();
    window.ReactNativeWebView = { postMessage };
    requestPushRetry();
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(JSON.parse(postMessage.mock.calls[0][0])).toEqual({ type: 'push-retry' });
  });

  it('outside the native shell requestPushRetry does nothing and goes nowhere pending', () => {
    expect(() => requestPushRetry()).not.toThrow();
    expect(isPushRetryPending()).toBe(false);
  });

  it('a bridge without a callable postMessage (partial) is not used and not pending', () => {
    window.ReactNativeWebView = {} as never;
    expect(() => requestPushRetry()).not.toThrow();
    expect(isPushRetryPending()).toBe(false);
  });

  it('a throwing postMessage does not leave the retry pending', () => {
    window.ReactNativeWebView = { postMessage: () => { throw new Error('gone'); } };
    expect(() => requestPushRetry()).not.toThrow();
    expect(isPushRetryPending()).toBe(false);
  });

  it('one press = one message: a second request while pending sends nothing; the shell event ends pending (also with no subscriber)', () => {
    const postMessage = vi.fn();
    window.ReactNativeWebView = { postMessage };
    requestPushRetry();
    requestPushRetry();
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(isPushRetryPending()).toBe(true);
    window.dispatchEvent(new CustomEvent(PUSH_REGISTER_EVENT));
    expect(isPushRetryPending()).toBe(false);
    requestPushRetry();
    expect(postMessage).toHaveBeenCalledTimes(2);
  });

  it('no listener piles up: every end (answer · give-up · throw) removes the one the request added', () => {
    vi.useFakeTimers();
    try {
      const add = vi.spyOn(window, 'addEventListener');
      const remove = vi.spyOn(window, 'removeEventListener');
      window.ReactNativeWebView = { postMessage: vi.fn() };
      for (let i = 0; i < 3; i += 1) {
        requestPushRetry();
        vi.advanceTimersByTime(21_000); // give up
      }
      window.ReactNativeWebView = { postMessage: () => { throw new Error('gone'); } };
      requestPushRetry(); // throw path
      window.ReactNativeWebView = { postMessage: vi.fn() };
      requestPushRetry();
      window.dispatchEvent(new CustomEvent(PUSH_REGISTER_EVENT)); // answer path
      const added = add.mock.calls.filter((c) => c[0] === PUSH_REGISTER_EVENT).length;
      const removed = remove.mock.calls.filter((c) => c[0] === PUSH_REGISTER_EVENT).length;
      expect(added).toBe(5);
      expect(removed).toBe(5);
      add.mockRestore();
      remove.mockRestore();
    } finally { vi.useRealTimers(); }
  });

  it('pending gives up by itself if the shell never answers', () => {
    vi.useFakeTimers();
    try {
      window.ReactNativeWebView = { postMessage: vi.fn() };
      const cb = vi.fn();
      const off = subscribePushRegister(cb);
      requestPushRetry();
      expect(isPushRetryPending()).toBe(true);
      vi.advanceTimersByTime(31_000);
      expect(isPushRetryPending()).toBe(false);
      expect(cb).toHaveBeenCalled(); // the subscribers hear the give-up
      off();
    } finally { vi.useRealTimers(); }
  });

  it('subscribePushRegister hears the shell event and stops after unsubscribe', () => {
    const cb = vi.fn();
    const off = subscribePushRegister(cb);
    window.dispatchEvent(new CustomEvent(PUSH_REGISTER_EVENT));
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    window.dispatchEvent(new CustomEvent(PUSH_REGISTER_EVENT));
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
