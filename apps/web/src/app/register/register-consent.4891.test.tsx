// @vitest-environment jsdom
//
// story 4891 (PO 11-11 · first step on a phone) — the consent line of /register: the box and its words are ONE press (the label); the two documents are their OWN links outside that label (before, the middle of the sentence was a link: a tap on the words
// opened the terms and the box stayed off). One checkbox still (AUTH-07 — unticked by default; the sign-up button and Google stay off until it is ticked).
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
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.resetModules(); });

async function mount(locale: 'ko' | 'en') {
  const { default: RegisterPage } = await import('./page');
  const messages = locale === 'ko' ? koMessages : enMessages;
  await act(async () => { root.render(<NextIntlClientProvider locale={locale} messages={messages} timeZone="Asia/Seoul"><RegisterPage /></NextIntlClientProvider>); });
}
const consent = () => container.querySelector('[data-testid="register-consent"]') as HTMLElement;
const box = () => consent().querySelector('[role="checkbox"]') as HTMLElement;

describe.each([['ko', koMessages.register], ['en', enMessages.register]] as const)('[SID:4891] the consent line (%s)', (locale, T) => {
  it('the label holds the box and the words «tosPrefix» — and no link', async () => {
    await mount(locale);
    const label = consent().querySelector('label')!;
    expect(label.contains(box())).toBe(true);
    expect(label.textContent?.trim()).toBe(T.tosPrefix);
    expect(label.querySelector('a')).toBeNull();
  });

  it('the box is named by the whole sentence (prefix + both documents), though the links sit outside the label', async () => {
    await mount(locale);
    expect(box().getAttribute('aria-label')).toBe(`${T.tosPrefix} ${T.termsOfService} ${T.and} ${T.privacyPolicy}`);
  });

  it('the two documents are their own links, outside the label, opening in a new tab', async () => {
    await mount(locale);
    const links = [...consent().querySelectorAll('a')];
    expect(links.map((a) => a.textContent?.trim())).toEqual([T.termsOfService, T.privacyPolicy]);
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/terms', '/privacy']);
    expect(links.every((a) => a.getAttribute('target') === '_blank')).toBe(true);
    expect(links.every((a) => !consent().querySelector('label')!.contains(a))).toBe(true);
    // the touch floor is a class of the link itself (the layout spec measures the pixels)
    expect(links.every((a) => /(^|\s)min-h-11(\s|$)/.test(a.className))).toBe(true);
  });

  it('a tap on the words ticks the box; a tap on a document link does not', async () => {
    await mount(locale);
    expect(box().getAttribute('aria-checked')).toBe('false');
    const words = consent().querySelector('label span:not([role="checkbox"])') as HTMLElement;
    await act(async () => { words.click(); });
    expect(box().getAttribute('aria-checked')).toBe('true');
    await act(async () => { words.click(); });
    expect(box().getAttribute('aria-checked')).toBe('false');
    for (const a of consent().querySelectorAll('a')) {
      a.addEventListener('click', (e) => e.preventDefault()); // jsdom cannot navigate
      await act(async () => { (a as HTMLElement).click(); });
    }
    expect(box().getAttribute('aria-checked')).toBe('false');
  });

  it('unticked: the sign-up button is off; ticked: the form can submit (only the other fields are missing)', async () => {
    await mount(locale);
    const submit = container.querySelector('[data-testid="register-submit"]') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await act(async () => { box().click(); });
    expect(box().getAttribute('aria-checked')).toBe('true');
    expect(container.querySelectorAll('[role="checkbox"]')).toHaveLength(1);
  });
});
