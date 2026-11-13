// @vitest-environment jsdom
//
// story 4924 — the login button is never switched off for empty boxes (it was `disabled` with no word — the same root as the «send» that was off for no stated reason, 4920). Pressed (or Enter) with a box empty, it says WHICH
// box is empty in the failed Banner (an alert — read aloud) and sends NOTHING to the server; with both filled it logs in as before.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

const { loginWithPasswordMock } = vi.hoisted(() => ({ loginWithPasswordMock: vi.fn() }));
vi.mock('@/lib/db/client', () => ({ loginWithPassword: loginWithPasswordMock }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }), useSearchParams: () => new URLSearchParams() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const L = koMessages.login;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); loginWithPasswordMock.mockReset(); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.resetModules(); });

async function mount() {
  const { default: LoginPage } = await import('./page');
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><LoginPage /></NextIntlClientProvider>); });
}
async function type(el: HTMLInputElement, value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); });
}
const signIn = () => ([...container.querySelectorAll('button')] as HTMLButtonElement[]).find((b) => b.textContent?.trim() === L.signIn)!;
const email = () => container.querySelector('input[type="email"]') as HTMLInputElement;
const password = () => container.querySelector('input[type="password"]') as HTMLInputElement;
const alertText = () => container.querySelector('[role="alert"]')?.textContent ?? null;
const press = async () => { await act(async () => { signIn().click(); await Promise.resolve(); }); };

describe('[SID:4924] login — empty boxes: the button stays on and says what is missing', () => {
  it('⭐both empty: the button is ON, pressing it says «이메일과 비밀번호를 입력해 주세요», nothing is sent', async () => {
    await mount();
    expect(signIn().disabled).toBe(false);
    expect(alertText()).toBeNull();
    await press();
    expect(alertText()).toBe(L.missingEmailAndPassword);
    expect(L.missingEmailAndPassword).toBe('이메일과 비밀번호를 입력해 주세요.');
    expect(loginWithPasswordMock).not.toHaveBeenCalled();
  });

  it('⭐the reason follows the empty box: only the password empty → the password line · only the e-mail empty → the e-mail line (whitespace counts as empty)', async () => {
    await mount();
    await type(email(), 'a@b.co');
    await press();
    expect(alertText()).toBe(L.missingPassword);
    await type(email(), '   ');
    await type(password(), 'pw');
    await press();
    expect(alertText()).toBe(L.missingEmail);
    expect(loginWithPasswordMock).not.toHaveBeenCalled();
  });

  it('Enter in a box does the same as the button (a reason, no request)', async () => {
    await mount();
    await act(async () => { email().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await Promise.resolve(); });
    expect(alertText()).toBe(L.missingEmailAndPassword);
    expect(loginWithPasswordMock).not.toHaveBeenCalled();
  });

  it('the reason is the ds failed Banner — an alert node a screen reader reads (role=alert)', async () => {
    await mount();
    await press();
    const el = container.querySelector('[role="alert"]')!;
    expect(el).not.toBeNull();
    expect(el.closest('[data-slot]')?.getAttribute('data-slot')).toBe('ds-banner');
  });

  it('both filled: logs in exactly as before (one request with the trimmed e-mail), no reason line', async () => {
    loginWithPasswordMock.mockResolvedValue({ data: { ok: true } });
    await mount();
    await type(email(), ' a@b.co ');
    await type(password(), 'pw');
    await press();
    expect(loginWithPasswordMock).toHaveBeenCalledTimes(1);
    expect(loginWithPasswordMock).toHaveBeenCalledWith('a@b.co', 'pw', undefined);
    expect(alertText()).toBeNull();
  });

  it('the reason shows up on the next press after typing too — a later try replaces it (no stale line)', async () => {
    loginWithPasswordMock.mockResolvedValue({ error: { code: 'INVALID_CREDENTIALS', message: 'x' } });
    await mount();
    await press();
    expect(alertText()).toBe(L.missingEmailAndPassword);
    await type(email(), 'a@b.co'); await type(password(), 'pw');
    await press();
    expect(alertText()).toBe(L.loginInvalidCredentials);
  });

  it('⭐pressing again with the same box empty is a NEW alert node (a repeated reason is read out again)', async () => {
    await mount();
    await press();
    const first = container.querySelector('[role="alert"]');
    expect(first).not.toBeNull();
    await press();
    const second = container.querySelector('[role="alert"]');
    expect(second?.textContent).toBe(L.missingEmailAndPassword);
    expect(second).not.toBe(first);
  });

  it('en has the three lines too', () => {
    expect(enMessages.login.missingEmailAndPassword).toBeTruthy();
    expect(enMessages.login.missingEmail).toBeTruthy();
    expect(enMessages.login.missingPassword).toBeTruthy();
  });
});
