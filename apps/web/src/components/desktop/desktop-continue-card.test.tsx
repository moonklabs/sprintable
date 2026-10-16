// @vitest-environment jsdom
//
// story 4712 — the confirm card of «브라우저 이어받기»: it shows whose account, makes NO request until a person presses [열기] (Kadir v2 ② — no
// auto-submit), then asks the server for the code once and goes to the address it answers; an off-shape answer is never followed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { DesktopContinueCard } from './desktop-continue-card';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CH = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const HERE = `/native/continue?code_challenge=${CH}&cc_method=S256&callback_mode=custom_scheme`;
let container: HTMLDivElement;
let root: Root;
const assign = vi.fn();

function mount(locale: 'ko' | 'en', returnApp: 'dev' | 'check' | null = null) {
  const messages = locale === 'ko' ? koMessages : enMessages;
  act(() => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={messages} timeZone="Asia/Seoul">
        <DesktopContinueCard account="jay@example.com" start={{ challenge: CH, returnApp }} here={HERE} />
      </NextIntlClientProvider>,
    );
  });
}
const button = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement;
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  assign.mockReset();
  vi.stubGlobal('location', { ...window.location, assign });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('DesktopContinueCard', () => {
  it('says whose account and what opening does — and makes no request by itself (ko · en)', () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    mount('ko');
    expect(container.querySelector('[data-testid=continue-account]')?.textContent).toBe('jay@example.com 계정으로 로그인해요.');
    expect(container.textContent).toContain('이 컴퓨터의 Sprintable 앱이 이 계정으로 로그인돼요');
    expect(button('열기')).toBeTruthy();
    expect(button('다른 계정으로')).toBeTruthy();
    act(() => root.unmount()); root = createRoot(container);
    mount('en');
    expect(container.querySelector('[data-testid=continue-account]')?.textContent).toBe('You will sign in as jay@example.com.');
    expect(f).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it('[열기] asks the server once with the app\'s start and goes to the return page it answers', async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { url: '/native/oauth-return?code=abc&app=dev' } }) });
    vi.stubGlobal('fetch', f);
    mount('ko', 'dev');
    act(() => button('열기').click());
    await flush();
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('/api/desktop/continue');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ code_challenge: CH, cc_method: 'S256', callback_mode: 'custom_scheme', return_app: 'dev' });
    expect(assign).toHaveBeenCalledWith('/native/oauth-return?code=abc&app=dev');
  });

  it('an answer that is not the return page\'s own address is never followed (an off-site address · an off-shape body)', async () => {
    for (const data of [{ url: 'https://evil.example/x' }, { url: '//evil.example' }, { url: 'javascript:alert(1)' }, {}]) {
      const f = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data }) });
      vi.stubGlobal('fetch', f);
      mount('ko');
      act(() => button('열기').click());
      await flush();
      expect(assign).not.toHaveBeenCalled();
      expect(container.querySelector('[role=alert]')?.textContent).toBe('열지 못했어요. 잠시 뒤 다시 눌러 주세요.');
      act(() => root.unmount()); root = createRoot(container);
    }
  });

  it('a refusal or a broken network shows the line and stays on the card (press again works)', async () => {
    const f = vi.fn().mockResolvedValueOnce({ ok: false, json: async () => ({ error: { code: 'RATE_LIMITED' } }) }).mockRejectedValueOnce(new Error('down'));
    vi.stubGlobal('fetch', f);
    mount('en');
    act(() => button('Open').click());
    await flush();
    expect(container.querySelector('[role=alert]')?.textContent).toBe('Could not open it. Please press it again in a moment.');
    act(() => button('Open').click());
    await flush();
    expect(f).toHaveBeenCalledTimes(2);
    expect(assign).not.toHaveBeenCalled();
  });

  it('[다른 계정으로] signs this browser out and returns to this same page (the start kept)', async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', f);
    mount('ko');
    act(() => button('다른 계정으로').click());
    await flush();
    expect(f).toHaveBeenCalledWith('/api/auth/logout', expect.objectContaining({ method: 'POST' }));
    expect(assign).toHaveBeenCalledWith(`/login?next=${encodeURIComponent(HERE)}`);
  });
});
