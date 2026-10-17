// @vitest-environment jsdom
//
// story 4712 — the confirm card of «브라우저 이어받기»: it shows whose account, makes NO request until a person presses [열기] (Kadir v2 ② — no
// auto-submit); the press is a plain form post (AC4 c) — the server makes the code and answers 303 to the return page.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
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
    expect(container.textContent).toContain('앱에서 직접 시작한 게 아니라면 열지 마세요'); // Yuna: what «직접 연» meant was ambiguous
    expect(button('열기')).toBeTruthy();
    expect(button('로그아웃하고 다른 계정으로')).toBeTruthy();
    act(() => root.unmount()); root = createRoot(container);
    mount('en');
    expect(container.querySelector('[data-testid=continue-account]')?.textContent).toBe('You will sign in as jay@example.com.');
    expect(button('Sign out and use another account')).toBeTruthy(); // the link says it signs this browser out
    expect(f).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it('[열기] is a plain form POST to /native/continue/open with the app\'s start — it needs no script (AC4 c: the same markup the server sends, before any hydration)', () => {
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <DesktopContinueCard account="jay@example.com" start={{ challenge: CH, returnApp: 'dev' }} here={HERE} />
      </NextIntlClientProvider>,
    );
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
    const form = doc.querySelector('form[data-testid=continue-form]') as HTMLFormElement; // reverted (a click handler) → no form, so no press without script
    expect(form.getAttribute('method')).toBe('post');
    expect(form.getAttribute('action')).toBe('/native/continue/open');
    const fields = Object.fromEntries([...form.querySelectorAll('input')].map((i) => [i.getAttribute('name'), i.getAttribute('value')]));
    expect(fields).toEqual({ code_challenge: CH, cc_method: 'S256', callback_mode: 'custom_scheme', return_app: 'dev' });
    const submit = form.querySelector('button[type=submit]') as HTMLButtonElement;
    expect(submit.textContent).toBe('열기');
    expect(submit.hasAttribute('disabled')).toBe(false); // a disabled-until-hydrated button would be the same «nothing happens»
    expect(html).not.toContain('onClick');
  });

  it('no return_app field when the app is the host\'s default; the card makes no request by itself and the press is not a fetch (the browser posts the form)', () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    mount('ko');
    const form = container.querySelector('form[data-testid=continue-form]') as HTMLFormElement;
    expect([...form.querySelectorAll('input')].map((i) => i.getAttribute('name'))).toEqual(['code_challenge', 'cc_method', 'callback_mode']);
    expect(f).not.toHaveBeenCalled();
  });

  it('after the press the button reads «여는 중…» (the page\'s script only adds the look; the post goes on) and a page restored from the back cache is pressable again', () => {
    mount('ko');
    const form = container.querySelector('form[data-testid=continue-form]') as HTMLFormElement;
    act(() => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(container.querySelector('button[type=submit]')?.textContent).toBe('여는 중…');
    expect((container.querySelector('button[type=submit]') as HTMLButtonElement).disabled).toBe(true); // no second press while it opens (each one would make a code)
    const again = new Event('submit', { bubbles: true, cancelable: true });
    act(() => { form.dispatchEvent(again); });
    expect(again.defaultPrevented).toBe(true); // reverted (aria-disabled only) → the second post goes through
    act(() => { const e = new Event('pageshow') as Event & { persisted: boolean }; e.persisted = true; window.dispatchEvent(e); });
    expect(container.querySelector('button[type=submit]')?.textContent).toBe('열기');
    expect((container.querySelector('button[type=submit]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('a failure the server sent back (failed) says so and the button is there again; without it no line', () => {
    mount('ko');
    expect(container.querySelector('[role=alert]')).toBeNull();
    act(() => root.unmount()); root = createRoot(container);
    act(() => {
      root.render(
        <NextIntlClientProvider locale="en" messages={enMessages} timeZone="Asia/Seoul">
          <DesktopContinueCard account="jay@example.com" start={{ challenge: CH, returnApp: null }} here={HERE} failed />
        </NextIntlClientProvider>,
      );
    });
    expect(container.querySelector('[role=alert]')?.textContent).toBe('Could not open it. Please press it again in a moment.');
    expect(container.querySelector('button[type=submit]')?.textContent).toBe('Open');
  });

  it('[로그아웃하고 다른 계정으로] signs this browser out and returns to this same page (the start kept)', async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', f);
    mount('ko');
    act(() => button('로그아웃하고 다른 계정으로').click());
    await flush();
    expect(f).toHaveBeenCalledWith('/api/auth/logout', expect.objectContaining({ method: 'POST' }));
    expect(assign).toHaveBeenCalledWith(`/login?next=${encodeURIComponent(HERE)}`);
  });
});
