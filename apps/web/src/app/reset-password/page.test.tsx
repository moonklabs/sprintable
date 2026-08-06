// @vitest-environment jsdom
//
// story #2484 — 재설정 실패가 error.code 분기 없이 json.error?.message(raw 서버 영문)를
// 그대로 노출하던 자리. code별 번역 문구, 알려지지 않은 code는 안전 폴백만 떠야 한다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams('token=tok-1'),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

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

async function mount() {
  const { default: ResetPasswordPage } = await import('./page');
  await act(async () => { root.render(wrap(<ResetPasswordPage />)); });
}

function setNativeValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

async function submit() {
  const pwInput = container.querySelector('input[type="password"]') as HTMLInputElement;
  await act(async () => { setNativeValue(pwInput, 'Abc123!!'); });
  const submitBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.resetPassword.submit);
  await act(async () => {
    submitBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  });
}

describe('ResetPasswordPage — error.code 분기 (story #2484)', () => {
  it('INVALID_TOKEN — raw 영문 대신 번역 문구', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      json: async () => ({ error: { code: 'INVALID_TOKEN', message: 'Reset token is invalid or expired' } }),
    })));
    await mount();
    await submit();
    const alertEl = container.querySelector('[role="alert"]');
    expect(alertEl?.textContent).not.toContain('Reset token is invalid');
    expect(alertEl?.textContent).toBe(koMessages.resetPassword.resetInvalidToken);
  });

  it('USER_NOT_FOUND — raw 영문 대신 번역 문구', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      json: async () => ({ error: { code: 'USER_NOT_FOUND', message: 'User not found' } }),
    })));
    await mount();
    await submit();
    const alertEl = container.querySelector('[role="alert"]');
    expect(alertEl?.textContent).not.toContain('User not found');
    expect(alertEl?.textContent).toBe(koMessages.resetPassword.resetUserNotFound);
  });

  it('알려지지 않은 code — 안전 폴백, raw message 미노출', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      json: async () => ({ error: { code: 'SOME_NEW_CODE', message: 'brand new raw string' } }),
    })));
    await mount();
    await submit();
    const alertEl = container.querySelector('[role="alert"]');
    expect(alertEl?.textContent).not.toContain('brand new raw string');
    expect(alertEl?.textContent).toBe(koMessages.resetPassword.submitFailed);
  });
});
