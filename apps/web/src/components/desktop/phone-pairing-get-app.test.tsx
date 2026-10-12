// @vitest-environment jsdom
// story 4654 (AC2): outside the phone app the pairing step says how to get it — one line, both store links, and a QR of each address
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';
import { PHONE_APP_STORE_ANDROID, PHONE_APP_STORE_IOS, phoneAppStoreLinks } from '@/lib/phone-app-store';

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
  // nothing is published yet (PHONE_APP_PUBLISHED both false): no get-app block, no link, no QR — the page keeps its one line
  it('nothing published: no get-app block, no store link, no QR', async () => {
    const h = await draw();
    expect(h.querySelector('[data-testid="phone-app-get"]')).toBeNull();
    expect(h.querySelectorAll('a').length).toBe(0);
    expect(h.querySelectorAll('svg').length).toBe(0);
  });

  it('the old «open it in the phone app» line stays', async () => {
    const h = await draw();
    expect(h.textContent).toContain('폰의 Sprintable 앱에서 이 화면을 열어 주세요');
  });
});
