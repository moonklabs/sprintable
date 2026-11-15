// @vitest-environment jsdom
//
// story 4891 (UI-8 · first screen · PO 11-10) — the Mac first screen BEFORE the download is pressed is read for «what do I press»: it carries ≤ 60 words (counted over every visible text node; the folded «Advanced» body is not on the screen),
// the phone app is one row that opens in place, the «after the download…» step appears only after the press, and the install-block guide stays for a build that is NOT notarized (the safety net — a notarized build never draws it).
// Each test names the line that, reverted, turns it red.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { OnboardingForm } from './onboarding-form';
import { PhoneAppRow } from '@/components/desktop/phone-app-card';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

vi.mock('@/lib/phone-app-store', async (orig) => ({ ...(await orig<typeof import('@/lib/phone-app-store')>()), PHONE_APP_PUBLISHED: { android: true, ios: true } }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
/** the budget PO set for the screen before the download press (PO 11-10: «약 55 언저리») */
export const WORD_BUDGET = 60;
let container: HTMLDivElement;
let root: Root;
const realUA = navigator.userAgent;

function stub(notarized: boolean) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const ok = (json: unknown) => ({ ok: true, status: 200, headers: new Headers(), json: async () => json });
    if (url.endsWith('/api/onboarding/events')) return ok({});
    if (url.endsWith('/api/auth/me')) return ok({ data: { member_id: 'u-1', email_verified: true, org_id: null, org_member_id: null, display_name: 'Jiwoo' } });
    if (url.endsWith('/api/invites/mine')) return ok({ invites: [] });
    if (url.endsWith('/api/organizations')) return ok({ data: { id: 'org-1' } });
    if (url.endsWith('/api/auth/refresh')) return ok({ data: { ok: true } });
    if (url.endsWith('/api/projects')) return ok({ data: { id: 'proj-1' } });
    if (url.endsWith('/api/current-project')) return ok({});
    if (url.endsWith('/desktop/downloads/macos.json')) {
      return { ok: true, json: async () => ({ product: 'Sprintable', version: '0.2.44', build: '2adcbf547', notarized, url: 'https://storage.googleapis.com/sprintable-desktop-releases/macos-electron/0.2.44/Sprintable-0.2.44-2adcbf547-arm64.dmg' }), headers: new Headers({ 'x-desktop-download-bucket': 'sprintable-desktop-releases' }) };
    }
    return { ok: false, status: 404, headers: new Headers(), json: async () => ({}) };
  }));
}

async function mount(locale: 'en' | 'ko', notarized = true) {
  stub(notarized);
  await act(async () => { root.render(<NextIntlClientProvider locale={locale} messages={(locale === 'en' ? enMessages : koMessages) as never} timeZone="UTC"><OnboardingForm todayHref="/today" chatsHref="/chats" /></NextIntlClientProvider>); });
  for (let k = 0; k < 4; k++) await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 20)); });
}

/** every visible text node, split on whitespace — a closed <details> shows only its <summary> */
function visibleWords(): number {
  const screen = container.querySelector('[data-testid="onboarding-first-mac"]')!;
  let n = 0;
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) { n += (node.textContent ?? '').trim().split(/\s+/).filter(Boolean).length; return; }
    const el = node as HTMLElement;
    if (el.tagName === 'DETAILS' && !(el as HTMLDetailsElement).open) { const sm = el.querySelector('summary'); if (sm) walk(sm); return; }
    el.childNodes.forEach(walk);
  };
  walk(screen);
  return n;
}
const byTestId = (id: string) => container.querySelector(`[data-testid=${id}]`);
const click = async (el: Element | null | undefined) => { expect(el).toBeTruthy(); await act(async () => { el!.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); };

beforeEach(() => {
  Object.defineProperty(navigator, 'userAgent', { value: MAC_UA, configurable: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, 'userAgent', { value: realUA, configurable: true });
});

describe('[SID:4891] the Mac first screen before the download press', () => {
  for (const locale of ['en', 'ko'] as const) {
    it(`⭐${locale}: at most ${WORD_BUDGET} visible words (before: en 159+ / ko 110+)`, async () => {
      await mount(locale);
      // reverted (the long lead · the phone card · the sentence org line · the after-download note back) → well over 60
      expect(visibleWords()).toBeLessThanOrEqual(WORD_BUDGET);
    });
  }

  it('⭐the «after the download…» step is not on the screen until the download is pressed, then it is', async () => {
    await mount('en');
    expect(byTestId('onboarding-first-after-note')).toBeNull();
    await click(byTestId('desktop-download-button'));
    expect(byTestId('onboarding-first-after-note')?.textContent).toBe(enMessages.onboarding.download.afterNote);
  });

  it('⭐a middle-click on the download (a new-tab download) counts as the press too', async () => {
    await mount('en');
    expect(byTestId('onboarding-first-after-note')).toBeNull();
    await act(async () => { byTestId('desktop-download-button')!.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 })); });
    expect(byTestId('onboarding-first-after-note')).not.toBeNull();
  });

  it('⭐two phone rows on one page do not share a region id; the controlled region stays in the page (hidden) while folded', async () => {
    await act(async () => { root.render(<NextIntlClientProvider locale="en" messages={enMessages as never} timeZone="UTC"><PhoneAppRow /><PhoneAppRow /></NextIntlClientProvider>); });
    const toggles = [...container.querySelectorAll('[data-testid=phone-app-row-toggle]')];
    expect(toggles).toHaveLength(2);
    const ids = toggles.map((t) => t.getAttribute('aria-controls'));
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) {
      const region = container.querySelector(`[id="${id}"]`);
      expect(region).not.toBeNull();
      expect((region as HTMLElement).hidden).toBe(true);
    }
  });

  it('⭐the phone app is one row; the QR card opens in place on a press and folds on the second', async () => {
    await mount('en');
    expect(byTestId('phone-app-card')).toBeNull();
    await click(byTestId('phone-app-row-toggle'));
    expect(byTestId('phone-app-card')).not.toBeNull();
    await click(byTestId('phone-app-row-toggle'));
    expect(byTestId('phone-app-card')).toBeNull();
  });

  it('the organization stays on the screen as a name chip (it stops a wrong attach) · the web way is still folded', async () => {
    await mount('en');
    expect(byTestId('onboarding-first-org')?.textContent).toBe(`${enMessages.onboarding.first.orgLead} Jiwoo's organization`.replace("Jiwoo's organization", "Jiwoo's organization"));
    expect((byTestId('onboarding-first-advanced') as HTMLDetailsElement).open).toBe(false);
  });

  it('a notarized build draws no install-block guide; a build that is NOT notarized keeps it (the safety net)', async () => {
    await mount('en', true);
    expect(byTestId('desktop-download-gatekeeper-title')).toBeNull();
    await act(async () => { root.render(<div />); });
    await mount('en', false);
    expect(byTestId('desktop-download-gatekeeper-title')).not.toBeNull();
  });
});
