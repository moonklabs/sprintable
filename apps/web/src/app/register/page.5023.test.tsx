// @vitest-environment jsdom
//
// story 5023 (B2-2, b) — the sign-up screen of a workspace SERVER: the setup code of the first account, the closed-server words, and the invitation token that lets an invited e-mail into a closed server.
// Mounted for real (the same harness as page.test.tsx): what is asserted is the DOM and what goes over the wire.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

const { pushMock, refreshMock, searchParamsRef } = vi.hoisted(() => ({ pushMock: vi.fn(), refreshMock: vi.fn(), searchParamsRef: { current: new URLSearchParams() } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: pushMock, refresh: refreshMock }), useSearchParams: () => searchParamsRef.current }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); searchParamsRef.current = new URLSearchParams(); pushMock.mockClear(); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.resetModules(); vi.unstubAllGlobals(); });

async function mount(locale: 'ko' | 'en' = 'ko') {
  const { default: RegisterPage } = await import('./page');
  await act(async () => { root.render(<NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul"><RegisterPage /></NextIntlClientProvider>); });
}
function setNativeValue(el: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
const setupInput = () => container.querySelector('[data-testid="register-setup-code"] input') as HTMLInputElement | null;
const submit = () => container.querySelector('[data-testid="register-submit"]') as HTMLButtonElement;
async function fill() {
  const [name] = [...container.querySelectorAll('input[type="text"]')].filter((i) => !i.closest('[data-testid="register-setup-code"]')) as HTMLInputElement[];
  await act(async () => {
    setNativeValue(name!, 'Test User');
    setNativeValue(container.querySelector('input[type="email"]') as HTMLInputElement, 'a@b.com');
    setNativeValue(container.querySelector('input[type="password"]') as HTMLInputElement, 'Abc123!!');
    (container.querySelector('[data-slot="ds-checkbox"]') as HTMLElement).click();
  });
}
async function press() { await act(async () => { submit().dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }); }
const alertText = () => container.querySelector('[role="alert"]')?.textContent;

/** the calls to /api/auth/register: the parsed bodies, and the answer to give */
function wire(answer: { ok: boolean; body: unknown }) {
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
    if (url === '/api/auth/register') { bodies.push(JSON.parse(init!.body!) as Record<string, unknown>); return { ok: answer.ok, json: async () => answer.body }; }
    if (url === '/api/me') return { ok: true, json: async () => ({ data: { org_id: 'o1' } }) };
    return { ok: false, json: async () => ({}) };
  }));
  return bodies;
}

describe('the setup code of a server with no owner yet', () => {
  it('a normal sign-up shows no setup field and sends none (hosted and the app are unchanged)', async () => {
    const bodies = wire({ ok: true, body: { data: { ok: true } } });
    await mount(); await fill();
    expect(setupInput()).toBeNull();
    await press();
    expect(bodies).toHaveLength(1); expect(bodies[0]).not.toHaveProperty('setup_code'); expect(bodies[0]).not.toHaveProperty('invite_token');
  });
  it('the server says SETUP_CODE_REQUIRED: the field appears (and the words say why), the button waits for a code, and the code goes over the wire with the next press', async () => {
    const bodies = wire({ ok: false, body: { error: { code: 'SETUP_CODE_REQUIRED', message: 'raw english' } } });
    await mount(); await fill(); await press();
    expect(setupInput()).not.toBeNull();
    expect(alertText()).toBe(koMessages.register.registerSetupCodeRequired); expect(alertText()).not.toContain('raw english');
    expect(submit().disabled).toBe(true); // a code is needed first
    expect(container.textContent).toContain(koMessages.register.setupCodeHint);
    expect(container.querySelector('[data-testid="register-setup-code"] code')?.textContent).toBe('sprintable-host server status'); // the command, in code type, under the hint
    await act(async () => { setNativeValue(setupInput()!, '  ABCD-EFGH-IJKL-MNOP '); });
    expect(submit().disabled).toBe(false);
    await press();
    expect(bodies).toHaveLength(2); expect(bodies[1]).toMatchObject({ setup_code: 'ABCD-EFGH-IJKL-MNOP', email: 'a@b.com' });
  });
  it('a code that was typed and is not right: the «not right» words, not the «needed» ones; the field stays', async () => {
    wire({ ok: false, body: { error: { code: 'SETUP_CODE_REQUIRED', message: 'x' } } });
    await mount(); await fill(); await press();
    await act(async () => { setNativeValue(setupInput()!, 'WRONG-WRONG-WRONG-1234'); });
    await press();
    expect(alertText()).toBe(koMessages.register.registerSetupCodeWrong); expect(setupInput()?.value).toBe('WRONG-WRONG-WRONG-1234');
  });
  it('the install notes link with ?setup=1: the field is there from the start, English words too', async () => {
    searchParamsRef.current = new URLSearchParams('setup=1');
    await mount('en');
    expect(setupInput()).not.toBeNull(); expect(container.querySelector('input[placeholder="Setup code"]')).not.toBeNull();
    expect(container.textContent).toContain(enMessages.register.setupCodeHint);
    expect(container.querySelector('[data-testid="register-setup-command"]')?.textContent).toBe('sprintable-host server status'); // the same command in both languages
  });
  it('with an owner (SIGNUP_CLOSED): the closed-server words — ask the owner for an invitation — and no setup field', async () => {
    wire({ ok: false, body: { error: { code: 'SIGNUP_CLOSED', message: 'raw english' } } });
    await mount('en'); await fill(); await press();
    expect(alertText()).toBe(enMessages.register.registerSignupClosed); expect(setupInput()).toBeNull();
  });
});

describe('an invited person on a closed server', () => {
  it('the token of the invitation link (in `next`) rides on the sign-up request; the person then goes back to the invitation', async () => {
    searchParamsRef.current = new URLSearchParams(`next=${encodeURIComponent('/invite/accept?token=tok_123')}`);
    const bodies = wire({ ok: true, body: { data: { ok: true } } });
    await mount(); await fill(); await press();
    expect(bodies[0]).toMatchObject({ invite_token: 'tok_123' }); expect(bodies[0]).not.toHaveProperty('setup_code');
    expect(pushMock).toHaveBeenCalledWith('/invite/accept?token=tok_123&signup=1');
  });
  it('a `next` that is not an invitation link carries no token', async () => {
    searchParamsRef.current = new URLSearchParams(`next=${encodeURIComponent('/inbox?token=abc')}`);
    const bodies = wire({ ok: true, body: { data: { ok: true } } });
    await mount(); await fill(); await press();
    expect(bodies[0]).not.toHaveProperty('invite_token');
  });
});
