// @vitest-environment jsdom
//
// story #2485 — error.code 분기(backend auth.py _err() 발급 안정 값): setup(USER_NOT_FOUND/
// TOTP_ALREADY_ENABLED), verify(USER_NOT_FOUND/TOTP_NOT_SETUP). disable은 그라운딩 결과
// backend에 라우트 자체가 없어(#2485 별도 보고) 항상 404 — code 분기 불가, raw 노출만 제거.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { TwoFactorSection } from './two-factor-section';
import koMessages from '../../../messages/ko.json';

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
});

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

describe('TwoFactorSection — error.code 분기 (story #2485)', () => {
  it('setup 실패(USER_NOT_FOUND) — raw 영문 대신 번역 문구', async () => {
    let setupCall = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/auth/2fa/setup') {
        setupCall += 1;
        if (setupCall === 1) {
          // 초기 마운트 감지 호출 — enabled/enrolling 둘 다 아니게 disabled로 안착.
          return { ok: false, status: 400, json: async () => ({ error: { code: 'X', message: 'x' } }) };
        }
        return { ok: false, status: 404, json: async () => ({ error: { code: 'USER_NOT_FOUND', message: 'User not found' } }) };
      }
      throw new Error('unexpected fetch: ' + url);
    }));
    await act(async () => { root.render(wrap(<TwoFactorSection />)); });
    await flush();

    const enableBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === koMessages.settings.twoFactorEnable);
    await act(async () => { enableBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(container.textContent).not.toContain('User not found');
    expect(container.textContent).toContain(koMessages.settings.twoFactorUserNotFound);
  });

  it('setup 실패(TOTP_ALREADY_ENABLED, 초기감지 아닌 재시도 케이스) — raw 영문 대신 번역 문구', async () => {
    let setupCall = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/auth/2fa/setup') {
        setupCall += 1;
        if (setupCall === 1) {
          return { ok: false, status: 400, json: async () => ({ error: { code: 'X', message: 'x' } }) };
        }
        return { ok: false, status: 409, json: async () => ({ error: { code: 'TOTP_ALREADY_ENABLED', message: 'Already enabled' } }) };
      }
      throw new Error('unexpected fetch: ' + url);
    }));
    await act(async () => { root.render(wrap(<TwoFactorSection />)); });
    await flush();

    const enableBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === koMessages.settings.twoFactorEnable);
    await act(async () => { enableBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(container.textContent).not.toContain('Already enabled');
    expect(container.textContent).toContain(koMessages.settings.twoFactorAlreadyEnabled);
  });

  it('verify 실패(TOTP_NOT_SETUP) — raw 영문 대신 번역 문구', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/auth/2fa/setup') {
        return { ok: true, json: async () => ({ data: { secret: 'ABCD1234', uri: 'otpauth://totp/x' } }) };
      }
      if (url === '/api/auth/2fa/verify' && init?.method === 'POST') {
        return { ok: false, status: 400, json: async () => ({ error: { code: 'TOTP_NOT_SETUP', message: 'Not set up' } }) };
      }
      throw new Error('unexpected fetch: ' + url);
    }));
    await act(async () => { root.render(wrap(<TwoFactorSection />)); });
    await flush();

    const input = container.querySelector('input') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(input, '123456'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    const verifyBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === koMessages.settings.twoFactorActivate);
    await act(async () => { verifyBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(container.textContent).not.toContain('Not set up');
    expect(container.textContent).toContain(koMessages.settings.twoFactorNotSetUp);
  });

  it('disable 실패(죽은 엔드포인트, 항상 404) — raw 영문 대신 고정 폴백', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/auth/2fa/setup') {
        return { ok: false, status: 409, json: async () => ({ error: { code: 'TOTP_ALREADY_ENABLED', message: 'x' } }) };
      }
      if (url === '/api/auth/2fa/disable' && init?.method === 'POST') {
        return { ok: false, status: 404, json: async () => ({ error: { code: 'NOT_FOUND', message: 'raw disable message' } }) };
      }
      throw new Error('unexpected fetch: ' + url);
    }));
    await act(async () => { root.render(wrap(<TwoFactorSection />)); });
    await flush();

    const input = container.querySelector('input') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(input, '654321'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    const disableBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === koMessages.settings.twoFactorDisable);
    await act(async () => { disableBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(container.textContent).not.toContain('raw disable message');
    expect(container.textContent).toContain(koMessages.settings.twoFactorSetupFailed);
  });
});
