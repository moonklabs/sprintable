// @vitest-environment jsdom
// story #4763 AC5 — /desktop: «앱 열기» first on a Mac; nothing on a device that is no Mac.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';
import { PhoneBridgeClaim } from '@/components/providers/phone-bridge-claim';

const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
let ua = MAC;
let inPhoneApp = false;
vi.mock('@/lib/phone-bridge', () => ({
  isPhoneApp: () => inPhoneApp,
  claimPhoneBridge: () => {},
  phoneCall: async () => ({ id: '', ok: false, code: 'not_phone_app' }),
  subscribePhoneApp: () => () => {},
}));
const { DesktopOpenAppCard } = await import('./desktop-open-app-card');
const { appSetupLink } = await import('@/lib/auth/native-return-app');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  ua = MAC;
  inPhoneApp = false;
  vi.spyOn(navigator, 'userAgent', 'get').mockImplementation(() => ua);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.restoreAllMocks();
});

async function mount(locale: 'ko' | 'en' = 'ko') {
  await act(async () => {
    root.render(
      <PhoneBridgeClaim>
        <NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="UTC"><DesktopOpenAppCard /></NextIntlClientProvider>
      </PhoneBridgeClaim>,
    );
  });
}
const button = () => container.querySelector('[data-testid="desktop-open-app-button"]') as HTMLAnchorElement | null;

describe('[SID:4763 AC5] DesktopOpenAppCard', () => {
  it('a Mac: «앱 열기» is the app\'s own setup link (the host\'s scheme) and one line says the download is below', async () => {
    await mount();
    expect(button()?.textContent).toBe(koMessages.desktop.openAppCta);
    expect(button()?.getAttribute('href')).toBe(appSetupLink(null));
    expect(container.querySelector('[data-testid="desktop-open-app-note"]')?.textContent).toBe(koMessages.desktop.openAppNoAppNote);
  });

  it('the first render on a Mac is the server\'s (nothing) — the card comes after mount, so the page hydrates cleanly (codex)', async () => {
    const { renderToString } = await import('react-dom/server');
    const html = renderToString(
      <PhoneBridgeClaim>
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="UTC"><DesktopOpenAppCard /></NextIntlClientProvider>
      </PhoneBridgeClaim>,
    );
    expect(html).not.toContain('desktop-open-app-card');
    await mount();
    expect(button()).not.toBeNull();
  });

  it('English too', async () => {
    await mount('en');
    expect(button()?.textContent).toBe(enMessages.desktop.openAppCta);
  });

  it('not a Mac (an iPhone · the phone app\'s shell): nothing drawn — no link that cannot open anything', async () => {
    ua = IPHONE;
    await mount();
    expect(container.querySelector('[data-testid="desktop-open-app-card"]')).toBeNull();
    root.unmount(); root = createRoot(container);
    ua = MAC;
    inPhoneApp = true;
    await mount();
    expect(container.querySelector('[data-testid="desktop-open-app-card"]')).toBeNull();
  });
});
