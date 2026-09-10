// @vitest-environment jsdom
//
// story #2485 — error.code 분기(backend auth.py _err() 발급 안정 값): setup(USER_NOT_FOUND/
// TOTP_ALREADY_ENABLED), verify(USER_NOT_FOUND/TOTP_NOT_SETUP). disable은 그라운딩 결과
// backend에 라우트 자체가 없어(#2485 별도 보고) 항상 404 — code 분기 불가, raw 노출만 제거.
//
// story #3768 — 마운트가 상태를 알려고 POST /api/auth/2fa/setup을 부르던 것(매번 새 시크릿을
// DB에 쓰는 클래스)을 GET /api/me의 totp_enabled 읽기로 교체 — 아래 전체가 그 계약으로
// 갱신됐다. setup POST는 이제 handleSetup(「켜기」 클릭)에서만 나간다.

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

function enableButton() {
  return Array.from(container.querySelectorAll('button')).find((b) => b.textContent === koMessages.settings.twoFactorEnable);
}

describe('TwoFactorSection — 마운트 읽기 계약(story #3768)', () => {
  // ⭐되돌리면 RED — 뮤테이션: 마운트 useEffect가 다시 POST /api/auth/2fa/setup을 부르면
  // 이 테스트가 그 호출을 "unexpected fetch"로 잡아 throw한다.
  it('⭐마운트 시 setup POST가 0회 — /api/me만 읽는다', async () => {
    let setupCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/me') return { ok: true, json: async () => ({ data: { totp_enabled: false } }) };
      if (url === '/api/auth/2fa/setup') { setupCalls += 1; throw new Error('unexpected setup POST on mount'); }
      throw new Error('unexpected fetch: ' + url);
    }));
    await act(async () => { root.render(wrap(<TwoFactorSection />)); });
    await flush();

    expect(setupCalls).toBe(0);
    expect(enableButton()).toBeTruthy(); // totp_enabled:false → disabled 상태(켜기 버튼 보임).
  });

  it('totp_enabled:true → enabled 상태(해제 UI, 켜기 버튼 없음)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/me') return { ok: true, json: async () => ({ data: { totp_enabled: true } }) };
      throw new Error('unexpected fetch: ' + url);
    }));
    await act(async () => { root.render(wrap(<TwoFactorSection />)); });
    await flush();

    expect(enableButton()).toBeFalsy();
    const disableBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === koMessages.settings.twoFactorDisable);
    expect(disableBtn).toBeTruthy();
  });

  // ⭐되돌리면 RED — 「모름」을 「꺼짐」으로 단정하면 이 테스트에서 켜기 버튼이 그려진다.
  it('⭐/api/me 실패(non-ok) → 「모름」(disabled 문구·켜기 버튼 0)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/me') return { ok: false, status: 500, json: async () => ({ error: { code: 'INTERNAL' } }) };
      throw new Error('unexpected fetch: ' + url);
    }));
    await act(async () => { root.render(wrap(<TwoFactorSection />)); });
    await flush();

    expect(container.textContent).toBe('');
    expect(enableButton()).toBeFalsy();
  });

  // ⭐되돌리면 RED — 네트워크 자체가 죽는(reject) 경로도 「모름」이어야 한다(disabled 아님).
  it('⭐/api/me 네트워크 reject → 「모름」(disabled 문구·켜기 버튼 0)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/me') throw new Error('network down');
      throw new Error('unexpected fetch: ' + url);
    }));
    await act(async () => { root.render(wrap(<TwoFactorSection />)); });
    await flush();

    expect(container.textContent).toBe('');
    expect(enableButton()).toBeFalsy();
  });

  // ⭐되돌리면 RED — 카디르 QA(2026-09-10): BE MeResponse.totp_enabled는 `bool | None`이라
  // null이 오는 실 분기가 있다(user 없는 org_member 폴백 등). `=== undefined`만 보면 null이
  // 「꺼짐」으로 단정돼 이 스토리가 막으려던 「모름≠꺼짐」 결함이 그대로 재발한다.
  it('⭐/api/me가 totp_enabled: null을 주면(BE 계약상 실제 분기) 「모름」 — 「꺼짐」으로 단정 안 함', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/me') return { ok: true, json: async () => ({ data: { totp_enabled: null } }) };
      throw new Error('unexpected fetch: ' + url);
    }));
    await act(async () => { root.render(wrap(<TwoFactorSection />)); });
    await flush();

    expect(container.textContent).toBe('');
    expect(enableButton()).toBeFalsy();
  });
});

describe('TwoFactorSection — error.code 분기 (story #2485)', () => {
  it('setup 실패(USER_NOT_FOUND) — raw 영문 대신 번역 문구', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/me') return { ok: true, json: async () => ({ data: { totp_enabled: false } }) };
      if (url === '/api/auth/2fa/setup') {
        return { ok: false, status: 404, json: async () => ({ error: { code: 'USER_NOT_FOUND', message: 'User not found' } }) };
      }
      throw new Error('unexpected fetch: ' + url);
    }));
    await act(async () => { root.render(wrap(<TwoFactorSection />)); });
    await flush();

    const enableBtn = enableButton();
    await act(async () => { enableBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(container.textContent).not.toContain('User not found');
    expect(container.textContent).toContain(koMessages.settings.twoFactorUserNotFound);
  });

  it('setup 실패(TOTP_ALREADY_ENABLED, 클릭 시점 레이스) — raw 영문 대신 번역 문구', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/me') return { ok: true, json: async () => ({ data: { totp_enabled: false } }) };
      if (url === '/api/auth/2fa/setup') {
        return { ok: false, status: 409, json: async () => ({ error: { code: 'TOTP_ALREADY_ENABLED', message: 'Already enabled' } }) };
      }
      throw new Error('unexpected fetch: ' + url);
    }));
    await act(async () => { root.render(wrap(<TwoFactorSection />)); });
    await flush();

    const enableBtn = enableButton();
    await act(async () => { enableBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(container.textContent).not.toContain('Already enabled');
    expect(container.textContent).toContain(koMessages.settings.twoFactorAlreadyEnabled);
  });

  it('verify 실패(TOTP_NOT_SETUP) — raw 영문 대신 번역 문구', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/me') return { ok: true, json: async () => ({ data: { totp_enabled: false } }) };
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

    const enableBtn = enableButton();
    await act(async () => { enableBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
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
      if (url === '/api/me') return { ok: true, json: async () => ({ data: { totp_enabled: true } }) };
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
