// @vitest-environment jsdom
//
// story 4669 (U6 · AC1 · Yuna A-5) — with Google on (NEXT_PUBLIC_OAUTH_ENABLED=true) the sign-up page leads with [Google로 계속];
// story 4891 (UI-8 U1 · PO 11-10): the e-mail form is on the same screen under it (it was folded behind [이메일로 가입]) — one screen, the terms checkbox still gating both ways. Harness as
// page.test.tsx (next/navigation mocked · the flag set per test). Reverted (the form open and Google below it) → T1 red.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

const { pushMock, refreshMock, searchParamsRef } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  refreshMock: vi.fn(),
  searchParamsRef: { current: new URLSearchParams() },
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, refresh: refreshMock }),
  useSearchParams: () => searchParamsRef.current,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const originalFlag = process.env['NEXT_PUBLIC_OAUTH_ENABLED'];

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  searchParamsRef.current = new URLSearchParams();
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  if (originalFlag === undefined) delete process.env['NEXT_PUBLIC_OAUTH_ENABLED'];
  else process.env['NEXT_PUBLIC_OAUTH_ENABLED'] = originalFlag;
  vi.resetModules();
});

async function mount() {
  const { default: RegisterPage } = await import('./page');
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><RegisterPage /></NextIntlClientProvider>);
  });
}

const byTestId = (id: string) => container.querySelector(`[data-testid=${id}]`);
const inputs = () => [...container.querySelectorAll('input')];

describe('[SID:4669 · 4891] RegisterPage — Google first, the e-mail form on the same screen', () => {
  it('T1 OAuth on: ONE screen — the terms line, then [Google로 계속] (the brand button, first control after the terms), then the three e-mail fields and [회원가입] — nothing folded, nothing to open', async () => {
    process.env['NEXT_PUBLIC_OAUTH_ENABLED'] = 'true';
    await mount();
    const google = byTestId('register-google') as HTMLAnchorElement;
    expect(google?.textContent?.trim()).toBe(koMessages.register.continueWithGoogle);
    expect(google.className).toContain('bg-ds-action'); // the one primary-colored control on the screen (the ds primary — story 4891)
    // reverted (the e-mail form folded behind a button again) → only the checkbox is here and the fold button exists
    expect(inputs().map((i) => i.type)).toEqual(['checkbox', 'text', 'email', 'password']);
    expect(byTestId('register-email-open')).toBeNull();
    const form = byTestId('register-email-form') as HTMLElement;
    expect(form).not.toBeNull();
    expect(container.textContent).toContain(koMessages.register.or);
    // the order: Google first (story 4669's «Google 먼저»), the e-mail form under it
    expect(google.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const submit = byTestId('register-submit') as HTMLButtonElement;
    expect(submit.textContent?.trim()).toBe(koMessages.register.submit);
    expect(submit.className).not.toContain('bg-ds-action'); // with Google on the e-mail way is the second way
  });

  it('T2 OAuth on, the terms gate BOTH ways (AUTH-07): unticked by default · [Google로 계속] goes nowhere and [회원가입] is off · ticking opens both · the e-mail request carries tos_accepted:true', async () => {
    process.env['NEXT_PUBLIC_OAUTH_ENABLED'] = 'true';
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/auth/register') return { ok: true, json: async () => ({ data: { ok: true } }) };
      return { ok: true, json: async () => ({ data: {} }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    await mount();
    const [terms, name, email, password] = inputs() as HTMLInputElement[];
    // the checkbox starts unticked (reverted — pre-ticked — both ways would be open here)
    expect(terms!.getAttribute('aria-checked') ?? String(terms!.checked)).not.toBe('true');
    expect((byTestId('register-google') as HTMLAnchorElement).getAttribute('href')).toBeNull();
    const submit = () => byTestId('register-submit') as HTMLButtonElement;
    const type = async (el: HTMLInputElement, value: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      await act(async () => { setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); });
    };
    await type(name!, '지우'); await type(email!, 'jiwoo@example.com'); await type(password!, 'Passw0rd!x');
    expect(submit().disabled, 'the fields alone do not open [회원가입] — the terms are not ticked').toBe(true);
    await act(async () => { (terms as HTMLInputElement).click(); });
    expect(submit().disabled).toBe(false);
    expect((byTestId('register-google') as HTMLAnchorElement).getAttribute('href')).toBe('/auth/login?provider=google&tos_accepted=true');
    await act(async () => { submit().click(); await Promise.resolve(); await Promise.resolve(); });
    const call = fetchMock.mock.calls.find((c) => c[0] === '/api/auth/register') as unknown as [string, RequestInit];
    expect(JSON.parse(String(call[1].body))).toEqual({ email: 'jiwoo@example.com', password: 'Passw0rd!x', display_name: '지우', tos_accepted: true });
    vi.unstubAllGlobals();
  });

  it('T2b the terms also gate the keyboard: Enter in a field while unticked sends nothing · the unticked Google is reachable by keyboard (focusable, aria-disabled) and Enter / Space on it says why', async () => {
    process.env['NEXT_PUBLIC_OAUTH_ENABLED'] = 'true';
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ data: { ok: true } }) }));
    vi.stubGlobal('fetch', fetchMock);
    await mount();
    const [, name, email, password] = inputs() as HTMLInputElement[];
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    for (const [el, v] of [[name, '지우'], [email, 'jiwoo@example.com'], [password, 'Passw0rd!x']] as const) {
      await act(async () => { setter.call(el!, v); el!.dispatchEvent(new Event('input', { bubbles: true })); });
    }
    await act(async () => { password!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await Promise.resolve(); });
    expect(fetchMock, 'Enter with the terms unticked sends no request').not.toHaveBeenCalled();
    const google = byTestId('register-google') as HTMLAnchorElement;
    expect(google.getAttribute('tabindex')).toBe('0');
    expect(google.getAttribute('aria-disabled')).toBe('true');
    await act(async () => { google.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
    expect(container.textContent).toContain(koMessages.register.tosRequiredError);
    await act(async () => { (inputs()[0] as HTMLInputElement).click(); });
    expect((byTestId('register-google') as HTMLAnchorElement).getAttribute('aria-disabled')).toBeNull();
    expect((byTestId('register-google') as HTMLAnchorElement).getAttribute('href')).toContain('tos_accepted=true');
    vi.unstubAllGlobals();
  });

  it('T3 OAuth off (OSS · local): the e-mail form is open as before · no Google · no fold button · [회원가입] is the brand button', async () => {
    delete process.env['NEXT_PUBLIC_OAUTH_ENABLED'];
    await mount();
    expect(byTestId('register-google')).toBeNull();
    expect(byTestId('register-email-open')).toBeNull();
    expect(byTestId('register-email-form')).not.toBeNull();
    expect(inputs().map((i) => i.type)).toEqual(['checkbox', 'text', 'email', 'password']);
    expect((byTestId('register-submit') as HTMLButtonElement).className).toContain('bg-ds-action');
    expect(container.textContent).not.toContain(koMessages.register.or);
  });

  it('T4 OAuth on: Google without the terms ticked says why and goes nowhere (as before) · ticked → the link carries next', async () => {
    process.env['NEXT_PUBLIC_OAUTH_ENABLED'] = 'true';
    searchParamsRef.current = new URLSearchParams('next=%2Fdesktop%2Fsetup');
    await mount();
    const google = byTestId('register-google') as HTMLAnchorElement;
    expect(google.getAttribute('href')).toBeNull();
    await act(async () => { google.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
    expect(container.textContent).toContain(koMessages.register.tosRequiredError);
    await act(async () => { (inputs()[0] as HTMLInputElement).click(); });
    expect((byTestId('register-google') as HTMLAnchorElement).getAttribute('href')).toBe('/auth/login?provider=google&tos_accepted=true&next=%2Fdesktop%2Fsetup');
  });
});
