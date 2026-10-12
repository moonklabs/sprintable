// @vitest-environment jsdom
// story 4654 (Yuna 5048): when a store is published its link and its QR show; the test flips the flags, the page reads them
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { PHONE_APP_STORE_ANDROID, PHONE_APP_STORE_IOS } from '@/lib/phone-app-store';

vi.mock('@/lib/phone-app-store', async (orig) => ({
  ...(await orig<typeof import('@/lib/phone-app-store')>()),
  PHONE_APP_PUBLISHED: { android: true, ios: false },
}));
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: () => Promise.reject(new Error('not used here')) }));
vi.mock('@/hooks/use-flat-href', () => ({ useFlatHref: () => (href: string) => href }));
const { PhonePairing } = await import('./phone-pairing');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('[SID:4654] a published store shows its link and QR; an unpublished one stays hidden', () => {
  it('Android published, iOS not: one link, one QR, the Android address', async () => {
    await act(async () => {
      root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="UTC"><PhonePairing /></NextIntlClientProvider>);
    });
    const block = host.querySelector('[data-testid="phone-app-get"]');
    expect(block).not.toBeNull();
    expect([...block!.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual([PHONE_APP_STORE_ANDROID]);
    expect(block!.querySelectorAll('svg').length).toBe(1);
    expect(host.textContent).not.toContain(PHONE_APP_STORE_IOS);
  });
});
