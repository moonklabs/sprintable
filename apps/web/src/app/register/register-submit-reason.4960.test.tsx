// @vitest-environment jsdom
//
// story 4960 (the 4959 lap · PO rule 11-13: a block says WHY, in place) — [회원가입] is off until the three fields and the terms box are done; it used to be a grey button and nothing else.
// Now the reason is one line under it: the empty field first, then the terms (the sentence the Google press already says); it goes away with the cause, and it is the button's description.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.resetModules(); vi.unstubAllGlobals(); });

async function mount(locale: 'ko' | 'en') {
  const { default: RegisterPage } = await import('./page');
  const messages = locale === 'ko' ? koMessages : enMessages;
  await act(async () => { root.render(<NextIntlClientProvider locale={locale} messages={messages} timeZone="Asia/Seoul"><RegisterPage /></NextIntlClientProvider>); });
}
function setNativeValue(el: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
const submit = () => container.querySelector('[data-testid="register-submit"]') as HTMLButtonElement;
const reason = () => container.querySelector('[data-testid="register-submit-reason"]') as HTMLElement | null;
const fill = async (name: string, email: string, pw: string) => {
  await act(async () => {
    setNativeValue(container.querySelector('input[type="text"]') as HTMLInputElement, name);
    setNativeValue(container.querySelector('input[type="email"]') as HTMLInputElement, email);
    setNativeValue(container.querySelector('input[type="password"]') as HTMLInputElement, pw);
  });
};
const tick = async () => { await act(async () => { (container.querySelector('[data-slot="ds-checkbox"]') as HTMLElement).click(); }); };

describe.each([['ko', koMessages.register], ['en', enMessages.register]] as const)('[SID:4960] why [회원가입] is off (%s)', (locale, T) => {
  it('⭐fields filled, terms not ticked → the button is off AND the reason (the terms sentence) is under it, as its description', async () => {
    await mount(locale);
    await fill('Test User', 'a@b.com', 'Abc123!!');
    expect(submit().disabled).toBe(true);
    expect(reason()?.textContent).toBe(T.tosRequiredError);
    expect(submit().getAttribute('aria-describedby')).toBe(reason()!.id);
    expect(submit().compareDocumentPosition(reason()!) & Node.DOCUMENT_POSITION_FOLLOWING, 'the reason sits under the button').toBeTruthy();
  });

  it('⭐ticking the box takes the reason away and turns the button on', async () => {
    await mount(locale);
    await fill('Test User', 'a@b.com', 'Abc123!!');
    await tick();
    expect(submit().disabled).toBe(false);
    expect(reason()).toBeNull();
    expect(submit().getAttribute('aria-describedby')).toBeNull();
  });

  it('an untouched screen says nothing (an empty form needs no line · the first screen keeps its room)', async () => {
    await mount(locale);
    expect(submit().disabled).toBe(true);
    expect(reason()).toBeNull();
  });

  it('an empty field is named first (the terms are not the blocker the person can act on first), whether or not the box is ticked', async () => {
    await mount(locale);
    await fill('Test User', '', '');
    expect(reason()?.textContent).toBe(T.fieldsRequiredHint);
    await tick();
    expect(submit().disabled).toBe(true);
    expect(reason()?.textContent, 'ticked, still empty: the fields are the reason').toBe(T.fieldsRequiredHint);
    await fill('Test User', '   ', 'Abc123!!'); // a blank e-mail is empty too
    expect(reason()?.textContent).toBe(T.fieldsRequiredHint);
    await fill('Test User', 'a@b.com', 'Abc123!!');
    expect(reason()).toBeNull();
  });

  it('the two sentences exist in both languages and are not empty', () => {
    expect(T.fieldsRequiredHint.trim().length).toBeGreaterThan(5);
    expect(T.tosRequiredError.trim().length).toBeGreaterThan(5);
  });

  it('while the request runs the button says «creating…» and the reason is not drawn (it is not blocked by a missing thing)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {}))); // never answers: the press stays in flight
    await mount(locale);
    await fill('Test User', 'a@b.com', 'Abc123!!');
    await tick();
    await act(async () => { submit().dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); });
    expect(submit().textContent).toBe(T.creatingAccount);
    expect(reason()).toBeNull();
  });
});
