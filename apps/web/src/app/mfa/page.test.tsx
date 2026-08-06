// @vitest-environment jsdom
//
// story #2484 — 검증 실패가 error.code 분기 없이 json.error?.message(raw 서버 영문)를
// 그대로 노출하던 자리. 이 페이지는 전체 하드코딩 영문(next-intl 미배선)이라 우리 자체
// 영문 카피로 code별 분기한다(서버 문자열을 그대로 쓰지 않는 것이 핵심).
// ⚠️그라운딩(#2484) 확認: 이 라우트는 현재 앱 내 어떤 링크·리다이렉트도 가리키지 않는
// 고아 경로다 — 그래도 요청 스코프대로 동일 원칙을 적용한다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
});

function setNativeValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

async function mountAndSubmit() {
  const { default: MfaPage } = await import('./page');
  await act(async () => { root.render(<MfaPage />); });
  const codeInput = container.querySelector('input[type="text"]') as HTMLInputElement;
  await act(async () => { setNativeValue(codeInput, '123456'); });
  const verifyBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Verify');
  await act(async () => {
    verifyBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  });
}

describe('MfaPage — error.code 분기 (story #2484)', () => {
  it('INVALID_TOTP — raw 영문 대신 자체 카피', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      json: async () => ({ error: { code: 'INVALID_TOTP', message: 'Invalid TOTP code' } }),
    })));
    await mountAndSubmit();
    const alertEl = container.querySelector('[role="alert"]');
    expect(alertEl?.textContent).not.toBe('Invalid TOTP code');
    expect(alertEl?.textContent).toContain('did not match');
  });

  it('TOTP_NOT_SETUP — raw 영문 대신 자체 카피', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      json: async () => ({ error: { code: 'TOTP_NOT_SETUP', message: 'TOTP not initialized' } }),
    })));
    await mountAndSubmit();
    const alertEl = container.querySelector('[role="alert"]');
    expect(alertEl?.textContent).not.toBe('TOTP not initialized');
    expect(alertEl?.textContent).toContain('not been set up');
  });

  it('알려지지 않은 code — 안전 폴백, raw message 미노출', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      json: async () => ({ error: { code: 'SOME_NEW_CODE', message: 'brand new raw string' } }),
    })));
    await mountAndSubmit();
    const alertEl = container.querySelector('[role="alert"]');
    expect(alertEl?.textContent).not.toContain('brand new raw string');
    expect(alertEl?.textContent).toBe('Invalid verification code. Please try again.');
  });
});
