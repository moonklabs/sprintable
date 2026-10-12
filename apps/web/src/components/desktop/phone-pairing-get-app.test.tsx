// @vitest-environment jsdom
// story 4654 (AC2): outside the phone app the pairing step says how to get it — one line, both store links, and a QR of each address
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';
import { PHONE_APP_STORE_ANDROID, PHONE_APP_STORE_IOS } from '@/lib/phone-app-store';

vi.mock('@/lib/db/client', () => ({ fetchWithAuth: () => Promise.reject(new Error('not used here')) }));
vi.mock('@/hooks/use-flat-href', () => ({ useFlatHref: () => (href: string) => href }));
const { PhonePairing } = await import('./phone-pairing');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

async function draw(locale: 'ko' | 'en' = 'ko') {
  const messages = locale === 'ko' ? koMessages : enMessages;
  await act(async () => {
    root.render(<NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC"><PhonePairing /></NextIntlClientProvider>);
  });
  return host;
}

describe('[SID:4654] the pairing step outside the phone app: how to get the app', () => {
  it('shows the get-app line, a link to each store, and a QR for each address', async () => {
    const h = await draw();
    const block = h.querySelector('[data-testid="phone-app-get"]');
    expect(block, 'the get-app block is drawn').not.toBeNull();
    expect(block!.querySelector('p')!.textContent).toBe('폰 앱 받기');
    const links = [...block!.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual([PHONE_APP_STORE_ANDROID, PHONE_APP_STORE_IOS]);
    expect(block!.querySelectorAll('svg').length, 'one QR per store').toBe(2);
  });

  it('the old «open it in the phone app» line stays', async () => {
    const h = await draw();
    expect(h.textContent).toContain('폰의 Sprintable 앱에서 이 화면을 열어 주세요');
  });
});
