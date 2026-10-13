// @vitest-environment jsdom
//
// story 4669 (U6 · AC1 · Yuna A-5) — with Google on (NEXT_PUBLIC_OAUTH_ENABLED=true) the sign-up page leads with [Google로 계속]
// and folds the e-mail form under [이메일로 가입]; a build with no OAuth keeps the e-mail form open as before. Harness as
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

describe('[SID:4669] RegisterPage — Google first, the e-mail form folded', () => {
  it('T1 OAuth on: [Google로 계속] is the first control after the terms line · no e-mail inputs · [이메일로 가입] folded (aria-expanded=false)', async () => {
    process.env['NEXT_PUBLIC_OAUTH_ENABLED'] = 'true';
    await mount();
    const google = byTestId('register-google') as HTMLAnchorElement;
    expect(google?.textContent?.trim()).toBe(koMessages.register.continueWithGoogle);
    expect(google.className).toContain('bg-brand'); // the one brand-colored control on the screen
    // the only inputs are the terms checkbox — the e-mail form is folded
    expect(inputs().map((i) => i.type)).toEqual(['checkbox']);
    expect(byTestId('register-email-form')).toBeNull();
    const open = byTestId('register-email-open');
    expect(open?.textContent?.trim()).toBe(koMessages.register.emailSignUp);
    expect(open?.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).toContain(koMessages.register.or);
    // Google comes before the fold button in the document
    expect(google.compareDocumentPosition(open!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('T2 OAuth on: [이메일로 가입] opens the form in place — name · e-mail · password · [회원가입] (not brand-colored) · the fold button is gone', async () => {
    process.env['NEXT_PUBLIC_OAUTH_ENABLED'] = 'true';
    await mount();
    await act(async () => { (byTestId('register-email-open') as HTMLButtonElement).click(); });
    expect(byTestId('register-email-form')).not.toBeNull();
    expect(inputs().map((i) => i.type)).toEqual(['checkbox', 'text', 'email', 'password']);
    expect(byTestId('register-email-open')).toBeNull();
    const submit = byTestId('register-submit') as HTMLButtonElement;
    expect(submit.textContent?.trim()).toBe(koMessages.register.submit);
    expect(submit.className).not.toContain('bg-brand');
    // Google still first, still the brand button
    expect((byTestId('register-google') as HTMLAnchorElement).className).toContain('bg-brand');
  });

  it('T3 OAuth off (OSS · local): the e-mail form is open as before · no Google · no fold button · [회원가입] is the brand button', async () => {
    delete process.env['NEXT_PUBLIC_OAUTH_ENABLED'];
    await mount();
    expect(byTestId('register-google')).toBeNull();
    expect(byTestId('register-email-open')).toBeNull();
    expect(byTestId('register-email-form')).not.toBeNull();
    expect(inputs().map((i) => i.type)).toEqual(['checkbox', 'text', 'email', 'password']);
    expect((byTestId('register-submit') as HTMLButtonElement).className).toContain('bg-brand');
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
