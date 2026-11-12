// @vitest-environment jsdom
//
// story 4831 (측정 중 찾은 기존 결함) — 가입 이름 칸에서 한글 조합 중의 엔터는 «글자 확정 키»인데 가입 제출로 읽혀, 반쯤 쓴 이름(실제 Chromium 실측: «홍길ㄷ»)으로
// 가입 요청이 나가고 확정 뒤 엔터에 또 나갔다. 조합 중(isComposing · keyCode 229)의 엔터는 제출하지 않고 기본 동작도 막지 않으며, 조합이 아닌 엔터는 그대로 제출한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); vi.resetModules(); });

function setNative(el: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
function key(el: Element, k: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(ev);
  return ev;
}

describe('가입 이름 칸 — 한글 조합 중 엔터 (story 4831 측정 중 발견)', () => {
  async function mountFilled() {
    const posts: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
      if (url === '/api/auth/register') posts.push(JSON.parse(init?.body ?? '{}'));
      return { ok: false, status: 400, json: async () => ({ error: { code: 'X', message: 'x' } }) };
    }));
    const { default: RegisterPage } = await import('./page');
    await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><RegisterPage /></NextIntlClientProvider>); });
    const name = container.querySelector<HTMLInputElement>('input[data-slot="ds-input"][type="text"]')!;
    const email = container.querySelector<HTMLInputElement>('input[data-slot="ds-input"][type="email"]')!;
    const pw = container.querySelector<HTMLInputElement>('input[data-slot="ds-input"][type="password"]')!;
    await act(async () => { setNative(email, 'a@b.co'); setNative(pw, 'Str0ng!Passw0rd#2026'); setNative(name, '홍길ㄷ'); });
    const tos = [...container.querySelectorAll('label span')].find((s) => s.textContent?.includes(koMessages.register.tosPrefix))!;
    await act(async () => { (tos as HTMLElement).click(); });
    return { posts, name };
  }

  it('조합 중의 엔터(isComposing · keyCode 229)는 가입 요청을 보내지 않고 기본 동작도 막지 않는다 · 입력은 그대로', async () => {
    const { posts, name } = await mountFilled();
    let ev!: KeyboardEvent;
    await act(async () => { ev = key(name, 'Enter', { isComposing: true }); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(posts).toHaveLength(0);
    expect(ev.defaultPrevented).toBe(false);
    expect(name.value).toBe('홍길ㄷ');
    await act(async () => { key(name, 'Enter', { keyCode: 229 }); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(posts).toHaveLength(0);
  });

  it('조합이 끝난 뒤의 엔터는 확정된 이름으로 가입 요청을 한 번 보낸다', async () => {
    const { posts, name } = await mountFilled();
    await act(async () => { setNative(name, '홍길동'); });
    await act(async () => { key(name, 'Enter'); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ display_name: '홍길동', email: 'a@b.co', tos_accepted: true });
  });
});
