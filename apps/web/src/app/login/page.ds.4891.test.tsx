// @vitest-environment jsdom
//
// story 4891 (UI-8 · the login screen on the ds parts) — what the first screen of a person with an account is made of, and what a screen reader or a phone gets: the two boxes (and the code box) are ds Inputs with a NAME (they had only
// a placeholder), [로그인] / [Firebase] / [Google] are ds Buttons (the Google link keeps its address and its icon), the failure line is the ds failed Banner (an alert that is read again when it repeats), the expired-session line is a
// ds note Banner, and no old `ui/` part is imported on the way. The requests and the branches are pinned by `page.test.tsx` (unchanged apart from the Banner's own attributes). The 390 touch measure (every press ≥ 44) is
// `e2e/login-bottom-links.4891.layout.spec.ts`.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { walkOldUi } from '@/components/settings/settings-tab-walk.helper';

const { loginWithPasswordMock, searchParamsRef } = vi.hoisted(() => ({ loginWithPasswordMock: vi.fn(), searchParamsRef: { current: new URLSearchParams() } }));
vi.mock('@/lib/db/client', () => ({ loginWithPassword: loginWithPasswordMock }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }), useSearchParams: () => searchParamsRef.current }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const L = koMessages.login;
let container: HTMLDivElement;
let root: Root;
const originalFlag = process.env['NEXT_PUBLIC_OAUTH_ENABLED'];
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); loginWithPasswordMock.mockReset(); searchParamsRef.current = new URLSearchParams(); });
afterEach(async () => {
  await act(async () => { root.unmount(); }); container.remove(); vi.resetModules();
  if (originalFlag === undefined) delete process.env['NEXT_PUBLIC_OAUTH_ENABLED']; else process.env['NEXT_PUBLIC_OAUTH_ENABLED'] = originalFlag;
});

async function mount() {
  const { default: LoginPage } = await import('./page');
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><LoginPage /></NextIntlClientProvider>); });
}
async function type(el: HTMLInputElement, value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); });
}
const signIn = () => ([...container.querySelectorAll('button')] as HTMLButtonElement[]).find((b) => b.textContent?.trim() === L.signIn)!;
const oldSlots = () => [...container.querySelectorAll('[data-slot]')].map((e) => e.getAttribute('data-slot')!).filter((s) => !s.startsWith('ds-'));
const email = () => container.querySelector('input[type="email"]') as HTMLInputElement;
const password = () => container.querySelector('input[type="password"]') as HTMLInputElement;

describe('[SID:4891] LoginPage on ds parts', () => {
  it('⭐the e-mail and password boxes are ds Inputs with a NAME (the placeholder is the hint, the name is the word); [로그인] is a ds Button that stays ON with empty boxes (4924 — it says what is missing when pressed; page.empty-fields.4924.test.tsx)', async () => {
    await mount();
    for (const [el, name] of [[email(), L.email], [password(), L.password]] as const) {
      expect(el.getAttribute('data-slot')).toBe('ds-input');
      expect(el.getAttribute('aria-label')).toBe(name);
      expect(el.placeholder).toBe(name);
    }
    expect(signIn().getAttribute('data-slot')).toBe('ds-button'); // the ds Button, not a hand-made <button>…
    expect(signIn().className).toContain('bg-ds-action'); // …in the primary look
    expect(signIn().disabled).toBe(false);
    await type(email(), 'a@b.co');
    expect(signIn().disabled).toBe(false);
    await type(password(), 'pw');
    expect(signIn().disabled).toBe(false);
  });

  it('the code box (after the server asks for it) is a ds Input with a name too, and takes the focus', async () => {
    loginWithPasswordMock.mockResolvedValue({ error: { code: 'TOTP_REQUIRED', message: 'x' } });
    await mount();
    await type(email(), 'a@b.co'); await type(password(), 'pw');
    await act(async () => { signIn().click(); await Promise.resolve(); await Promise.resolve(); });
    const code = container.querySelector('input[inputmode="numeric"]') as HTMLInputElement;
    expect(code.getAttribute('data-slot')).toBe('ds-input');
    expect(code.getAttribute('aria-label')).toBe(L.totpPlaceholder);
    expect(document.activeElement).toBe(code);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(L.totpRequired);
  });

  it('⭐a failed try is ONE alert, the ds failed Banner; a second identical failure is a NEW node (read out again); a try that goes through leaves none', async () => {
    loginWithPasswordMock.mockResolvedValue({ error: { code: 'INVALID_CREDENTIALS', message: 'x' } });
    await mount();
    await type(email(), 'a@b.co'); await type(password(), 'pw');
    const press = async () => { await act(async () => { signIn().click(); await Promise.resolve(); await Promise.resolve(); }); };
    await press();
    const first = container.querySelector('[role="alert"]') as HTMLElement;
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(first.getAttribute('data-slot')).toBe('ds-banner');
    expect(first.textContent).toBe(L.loginInvalidCredentials);
    await press();
    expect(container.querySelector('[role="alert"]')).not.toBe(first);
    loginWithPasswordMock.mockResolvedValue({ data: {} });
    await press();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('the expired-session line is a ds Banner (a calm note, not a failure) above the fields', async () => {
    searchParamsRef.current = new URLSearchParams('reason=session_expired');
    await mount();
    const note = container.querySelector('[data-slot="ds-banner"]') as HTMLElement;
    expect(note.textContent).toBe(L.sessionExpired);
    expect(note.getAttribute('data-tone')).toBe('note');
    expect(note.compareDocumentPosition(email()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('⭐Google: the same address (with tos_accepted and the page to return to), the same icon and words, drawn by the ds Button; the notice stays its next sibling', async () => {
    process.env['NEXT_PUBLIC_OAUTH_ENABLED'] = 'true';
    searchParamsRef.current = new URLSearchParams('next=%2Finvite%2Fabc');
    await mount();
    const google = container.querySelector('a[href^="/auth/login?provider=google"]') as HTMLAnchorElement;
    expect(google.getAttribute('href')).toBe('/auth/login?provider=google&tos_accepted=true&next=%2Finvite%2Fabc');
    expect(google.textContent?.trim()).toBe(L.google);
    expect(google.querySelector('svg')).not.toBeNull();
    expect(google.className.split(/\s+/)).toContain('border-ds-line-control'); // the ds secondary look: the EXACT class token (a substring would also match every variant's «disabled:border-ds-line-control»)
    expect(google.nextElementSibling?.getAttribute('data-testid')).toBe('login-terms-line');
  });

  it('nothing old is drawn (data-slot) and the walk of the page’s and the Mac block’s imports meets no old ui/ part', async () => {
    process.env['NEXT_PUBLIC_OAUTH_ENABLED'] = 'true';
    await mount();
    expect(oldSlots()).toEqual([]);
    expect(container.querySelectorAll('[data-slot^="ds-"]').length).toBeGreaterThan(2);
    const { olds, seen } = walkOldUi([path.join(__dirname, 'page.tsx'), path.join(__dirname, 'mac-app-offer.tsx')]);
    expect(seen.length).toBeGreaterThan(2);
    expect(olds, `old ui/ imports on the login:\n${olds.join('\n')}`).toEqual([]);
    expect(readFileSync(path.join(__dirname, 'page.tsx'), 'utf8')).not.toMatch(/<(button|input)\b/); // no hand-made button / box of its own
  });
});
