// @vitest-environment jsdom
//
// story 4891 (UI-8 · the sign-up screen on the ds parts) — what the first screen of a person with NO account is made of, and what a screen reader or a phone gets: the three boxes are ds Inputs with a NAME (they had only a placeholder),
// the consent is the ds Checkbox (box + words = ONE press) named by the whole sentence, [회원가입] is a ds Button (primary when the e-mail way is the only way, secondary when Google leads), the Google link is drawn in the ds primary
// look but STILL takes the press while the terms are unticked (it is the press that says why), the failure line is the ds failed Banner (a new node on every repeat), the password boxes marks `aria-invalid` until the rule is met,
// and no old `ui/` part is imported on the way. The requests and the branches are pinned by `page.test.tsx` / `page.google-first.4669.test.tsx` / `register-consent.4891.test.tsx`. The 390 touch measure: `e2e/register-verify-wait.4891.layout.spec.ts`.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { walkOldUi } from '@/components/settings/settings-tab-walk.helper';

const { pushMock, refreshMock, searchParamsRef } = vi.hoisted(() => ({ pushMock: vi.fn(), refreshMock: vi.fn(), searchParamsRef: { current: new URLSearchParams() } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: pushMock, refresh: refreshMock }), useSearchParams: () => searchParamsRef.current }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const R = koMessages.register;
let container: HTMLDivElement;
let root: Root;
const originalFlag = process.env['NEXT_PUBLIC_OAUTH_ENABLED'];
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); searchParamsRef.current = new URLSearchParams(); });
afterEach(async () => {
  await act(async () => { root.unmount(); }); container.remove(); vi.resetModules(); vi.unstubAllGlobals();
  if (originalFlag === undefined) delete process.env['NEXT_PUBLIC_OAUTH_ENABLED']; else process.env['NEXT_PUBLIC_OAUTH_ENABLED'] = originalFlag;
});

async function mount(oauth = false) {
  if (oauth) process.env['NEXT_PUBLIC_OAUTH_ENABLED'] = 'true'; else delete process.env['NEXT_PUBLIC_OAUTH_ENABLED'];
  const { default: RegisterPage } = await import('./page');
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><RegisterPage /></NextIntlClientProvider>); });
}
async function type(el: HTMLInputElement, value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); });
}
const nameBox = () => container.querySelector('input[type="text"]') as HTMLInputElement;
const emailBox = () => container.querySelector('input[type="email"]') as HTMLInputElement;
const pwBox = () => container.querySelector('input[type="password"]') as HTMLInputElement;
const submit = () => container.querySelector('[data-testid="register-submit"]') as HTMLButtonElement;
const tosBox = () => container.querySelector('[role="checkbox"]') as HTMLElement;
const google = () => container.querySelector('[data-testid="register-google"]') as HTMLAnchorElement;
const oldSlots = () => [...container.querySelectorAll('[data-slot]')].map((e) => e.getAttribute('data-slot')!).filter((s) => !s.startsWith('ds-'));

describe('[SID:4891] RegisterPage on ds parts', () => {
  it('⭐the three boxes are ds Inputs with a NAME (the placeholder is the hint, the name is the word)', async () => {
    await mount();
    for (const [el, name] of [[nameBox(), R.namePlaceholder], [emailBox(), R.emailPlaceholder], [pwBox(), R.passwordPlaceholder]] as const) {
      expect(el.getAttribute('data-slot')).toBe('ds-input');
      expect(el.getAttribute('aria-label')).toBe(name);
      expect(el.placeholder).toBe(name);
    }
  });

  it('[회원가입] is a ds Button: the primary one when e-mail is the only way, the secondary one when Google leads; off until the three boxes are filled AND the terms are ticked', async () => {
    await mount(false);
    expect(submit().getAttribute('data-slot')).toBe('ds-button');
    expect(submit().className).toContain('bg-ds-action');
    expect(submit().disabled).toBe(true);
    await type(nameBox(), 'Ji'); await type(emailBox(), 'a@b.co'); await type(pwBox(), 'Abc123!!');
    expect(submit().disabled).toBe(true); // terms still unticked
    await act(async () => { tosBox().click(); });
    expect(submit().disabled).toBe(false);
    root.unmount(); root = createRoot(container);
    await mount(true);
    expect(submit().className).not.toContain('bg-ds-action');
    expect(submit().className.split(/\s+/)).toContain('border-ds-line-control'); // the ds secondary look: the EXACT class token (a substring would also match every variant's «disabled:border-ds-line-control»)
  });

  it('⭐Google: unticked → no address, announced as unavailable (aria-disabled), the press still reaches it (pointer events back on) and says why in an alert; ticked → the address with the consent and the page to return to', async () => {
    searchParamsRef.current = new URLSearchParams('next=%2Finvite%2Fabc');
    await mount(true);
    expect(google().getAttribute('href')).toBeNull();
    expect(google().getAttribute('aria-disabled')).toBe('true');
    expect(google().className).toContain('aria-disabled:pointer-events-auto'); // buttonVariants() switches pointer events OFF for aria-disabled; this brings them back
    await act(async () => { google().click(); });
    const first = container.querySelector('[role="alert"]') as HTMLElement;
    expect(first.textContent).toBe(R.tosRequiredError);
    expect(first.getAttribute('data-slot')).toBe('ds-banner');
    await act(async () => { tosBox().click(); });
    expect(google().getAttribute('href')).toBe('/auth/login?provider=google&tos_accepted=true&next=%2Finvite%2Fabc');
    expect(google().getAttribute('aria-disabled')).toBeNull();
    expect(google().className).toContain('bg-ds-action');
  });

  it('⭐a failed sign-up is ONE alert, the ds failed Banner; the same failure again is a NEW node (read out again)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({ error: { code: 'EMAIL_TAKEN', message: 'x' } }) })));
    await mount();
    await type(nameBox(), 'Ji'); await type(emailBox(), 'a@b.co'); await type(pwBox(), 'Abc123!!');
    await act(async () => { tosBox().click(); });
    const press = async () => { await act(async () => { submit().click(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }); };
    await press();
    const first = container.querySelector('[role="alert"]') as HTMLElement;
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(first.getAttribute('data-slot')).toBe('ds-banner');
    expect(first.getAttribute('data-tone')).toBe('failed');
    expect(first.textContent).toBe(R.registerEmailTaken);
    await press();
    const second = container.querySelector('[role="alert"]') as HTMLElement | null;
    expect(second).not.toBeNull(); // a second failure is shown at all …
    expect(second).not.toBe(first); // … and as a NEW node
    expect(second!.textContent).toBe(R.registerEmailTaken);
  });

  it('the password box is marked invalid (aria-invalid → the ds failed border) once it was typed in and the rule is not met; met → not marked', async () => {
    await mount();
    expect(pwBox().getAttribute('aria-invalid')).toBeNull();
    await type(pwBox(), 'abc');
    expect(pwBox().getAttribute('aria-invalid')).toBe('true');
    await type(pwBox(), 'Abc123!!');
    expect(pwBox().getAttribute('aria-invalid')).toBeNull();
  });

  it('the rule lines carry the ds tones (met = done colour, not met = muted) and a mark (✓ / ○), never colour alone', async () => {
    await mount();
    await type(pwBox(), 'abc');
    const items = [...container.querySelectorAll('ul li')] as HTMLElement[];
    expect(items.length).toBe(2);
    expect(items.every((li) => li.className.includes('text-ds-ink-3') && li.textContent?.startsWith('○'))).toBe(true);
    await type(pwBox(), 'Abc123!!');
    expect([...container.querySelectorAll('ul li')].every((li) => (li as HTMLElement).className.includes('text-ds-done') && li.textContent?.startsWith('✓'))).toBe(true);
  });

  it('«이미 계정이 있으신가요? 로그인»: the link is a 44 press (the words stay a plain sentence)', async () => {
    await mount();
    const link = [...container.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/login')!;
    expect(link.textContent?.trim()).toBe(R.signIn);
    expect(link.className).toMatch(/(^|\s)min-h-11(\s|$)/);
    expect(link.className).toMatch(/(^|\s)min-w-11(\s|$)/);
  });

  it('nothing old is drawn (data-slot) and the walk of the page’s imports meets no old ui/ part; no hand-made button / box of its own', async () => {
    await mount(true);
    expect(oldSlots()).toEqual([]);
    const { olds, seen } = walkOldUi([path.join(__dirname, 'page.tsx')]);
    expect(seen.length).toBeGreaterThan(2);
    expect(olds, `old ui/ imports on the sign-up:\n${olds.join('\n')}`).toEqual([]);
    expect(readFileSync(path.join(__dirname, 'page.tsx'), 'utf8')).not.toMatch(/<(button|input)\b/);
  });
});
