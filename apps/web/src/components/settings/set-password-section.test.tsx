// @vitest-environment jsdom
//
// story #2485 — code로 분기(backend auth.py set_password()가 _err()로 직접 발급하는
// 안정 값: USER_NOT_FOUND, ALREADY_HAS_PASSWORD). 이 컴포넌트는 next-intl 미배선이라
// 인라인 영문 문구로 분기한다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SetPasswordSection } from './set-password-section';

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
});

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

function setNativeValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('SetPasswordSection — error.code 분기 (story #2485)', () => {
  it('ALREADY_HAS_PASSWORD — raw 영문 대신 인라인 영문 고정 문구', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/me') return { ok: true, json: async () => ({ data: { has_password: false } }) };
      if (url === '/api/auth/set-password') {
        return { ok: false, json: async () => ({ error: { code: 'ALREADY_HAS_PASSWORD', message: 'User already has a password set' } }) };
      }
      throw new Error('unexpected fetch: ' + url);
    }));
    await act(async () => { root.render(<SetPasswordSection />); });
    await flush();
    const [pw, confirm] = Array.from(container.querySelectorAll('input[type="password"]')) as HTMLInputElement[];
    await act(async () => { setNativeValue(pw, 'Str0ng!Pass'); });
    await act(async () => { setNativeValue(confirm, 'Str0ng!Pass'); });
    const submitBtn = Array.from(container.querySelectorAll('button')).find((b) => /Set Password/i.test(b.textContent ?? ''));
    await act(async () => { submitBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(container.textContent).not.toContain('User already has a password set');
    expect(container.textContent).toContain('A password is already set for this account.');
  });

  it('USER_NOT_FOUND — raw 영문 대신 인라인 영문 고정 문구', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/me') return { ok: true, json: async () => ({ data: { has_password: false } }) };
      if (url === '/api/auth/set-password') {
        return { ok: false, json: async () => ({ error: { code: 'USER_NOT_FOUND', message: 'User not found' } }) };
      }
      throw new Error('unexpected fetch: ' + url);
    }));
    await act(async () => { root.render(<SetPasswordSection />); });
    await flush();
    const [pw, confirm] = Array.from(container.querySelectorAll('input[type="password"]')) as HTMLInputElement[];
    await act(async () => { setNativeValue(pw, 'Str0ng!Pass'); });
    await act(async () => { setNativeValue(confirm, 'Str0ng!Pass'); });
    const submitBtn = Array.from(container.querySelectorAll('button')).find((b) => /Set Password/i.test(b.textContent ?? ''));
    await act(async () => { submitBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(container.textContent).not.toContain('User not found');
    expect(container.textContent).toContain('We could not find your account.');
  });

  it('알려지지 않은 code — 안전 폴백, raw message 미노출', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/me') return { ok: true, json: async () => ({ data: { has_password: false } }) };
      if (url === '/api/auth/set-password') {
        return { ok: false, json: async () => ({ error: { code: 'SOME_NEW_CODE', message: 'brand new raw string' } }) };
      }
      throw new Error('unexpected fetch: ' + url);
    }));
    await act(async () => { root.render(<SetPasswordSection />); });
    await flush();
    const [pw, confirm] = Array.from(container.querySelectorAll('input[type="password"]')) as HTMLInputElement[];
    await act(async () => { setNativeValue(pw, 'Str0ng!Pass'); });
    await act(async () => { setNativeValue(confirm, 'Str0ng!Pass'); });
    const submitBtn = Array.from(container.querySelectorAll('button')).find((b) => /Set Password/i.test(b.textContent ?? ''));
    await act(async () => { submitBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(container.textContent).not.toContain('brand new raw string');
    expect(container.textContent).toContain('Failed to set password.');
  });
});
