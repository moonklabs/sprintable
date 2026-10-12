// @vitest-environment jsdom
// story 4654 (Yuna 4654-phone-app-cta-design §1 · §3): on a device that is not a Mac, the onboarding desktop step places the phone app's
// store links (PhoneAppGet — only the published stores) under the download card, with the aux line «맥 앱은 맥에서 받아 주세요».
// On a Mac the card is not drawn at all (the Mac app's own card stays alone). Nothing published → no card, no line.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { PHONE_APP_STORE_ANDROID } from '@/lib/phone-app-store';

vi.mock('@/lib/phone-app-store', async (orig) => ({
  ...(await orig<typeof import('@/lib/phone-app-store')>()),
  PHONE_APP_PUBLISHED: { android: true, ios: false },
}));
const { PhoneAppCard } = await import('./phone-app-card');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const REAL_UA = navigator.userAgent;
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const setUA = (ua: string) => Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true });
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); setUA(REAL_UA); });

// no forced flag: the device is read from navigator.userAgent, as the page does (the Mac check is the card's own)
async function draw(elsewhere?: boolean) {
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="UTC"><PhoneAppCard {...(elsewhere === undefined ? {} : { elsewhere })} /></NextIntlClientProvider>);
  });
  return host;
}

describe('[SID:4654] the phone app card under the onboarding download card', () => {
  it('not a Mac: the aux line and the published store link + QR', async () => {
    const h = await draw(true);
    expect(h.textContent).toContain('맥 앱은 맥에서 받아 주세요');
    expect(h.querySelector('[data-testid="phone-app-get"]')).not.toBeNull();
    expect([...h.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual([PHONE_APP_STORE_ANDROID]);
  });

  // Yuna 5049 CHANGES: the body line sits under the title, in the words of phonePairing.needPhoneAppBody (fixed here)
  it('the body line under the title reads exactly the Yuna words (ko)', async () => {
    const h = await draw(true);
    const body = h.querySelector('[data-testid="phone-app-body"]');
    expect(body?.textContent).toBe('폰에서 이 컴퓨터의 에이전트에 답하고, 멈추거나 지시하려면 폰 앱이 필요해요.');
    const title = h.querySelector('[data-testid="phone-app-get"] p');
    expect(title?.textContent).toBe('폰 앱 받기');
    expect(title!.compareDocumentPosition(body!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('a Mac: nothing is drawn (the Mac app card stays alone on the page)', async () => {
    const h = await draw(false);
    expect(h.innerHTML).toBe('');
  });

  // Kadir 5049: the device comes from the user agent the page reads (no forced flag) — a Mac draws nothing, a phone draws the line and the link
  it('no forced flag: a Mac user agent draws nothing', async () => {
    setUA(MAC);
    const h = await draw();
    expect(h.innerHTML).toBe('');
  });

  it('no forced flag: a phone user agent draws the aux line and the published link', async () => {
    setUA(IPHONE);
    const h = await draw();
    expect(h.textContent).toContain('맥 앱은 맥에서 받아 주세요');
    expect([...h.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual([PHONE_APP_STORE_ANDROID]);
  });
});
