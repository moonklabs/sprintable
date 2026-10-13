// @vitest-environment jsdom
// story 4654 (Yuna 4654-phone-app-cta-design §1 · §3): the onboarding desktop step places the phone app's links (PhoneAppGet) under the
// download card; not a Mac → the aux line «맥 앱은 맥에서 받아 주세요» too.
// [SID:4671] (UX-1 · U3): a Mac draws the card as well (the QR is for the phone's camera) with «scan it with your phone» instead of the
// aux line; iOS has its «준비 중» line. Nothing to get → no card, no line (phone-pairing-get-app.test.tsx · phoneAppLinks = []).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { PHONE_APP_STORE_ANDROID } from '@/lib/phone-app-store';
import { PhoneBridgeClaim } from '@/components/providers/phone-bridge-claim';

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
    root.render(<PhoneBridgeClaim><NextIntlClientProvider locale="ko" messages={koMessages} timeZone="UTC"><PhoneAppCard {...(elsewhere === undefined ? {} : { elsewhere })} /></NextIntlClientProvider></PhoneBridgeClaim>);
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

  it('no forced flag: a phone user agent draws the aux line and the published link', async () => {
    setUA(IPHONE);
    const h = await draw();
    expect(h.textContent).toContain('맥 앱은 맥에서 받아 주세요');
    expect([...h.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual([PHONE_APP_STORE_ANDROID]);
  });
});

describe('[SID:4671] a Mac draws the card too (the QR is for the phone)', () => {
  it('forced Mac: the card, the link + QR, «scan it with your phone» — and no «맥 앱은 맥에서» line', async () => {
    const h = await draw(false);
    expect(h.querySelector('[data-testid="phone-app-card"]')).not.toBeNull();
    expect([...h.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual([PHONE_APP_STORE_ANDROID]);
    expect(h.querySelectorAll('svg').length).toBe(1);
    expect(h.querySelector('[data-testid="phone-app-scan-hint"]')?.textContent).toBe('폰 카메라로 QR을 찍으면 바로 열려요');
    expect(h.querySelector('[data-testid="phone-app-mac-aux"]')).toBeNull();
    expect(h.textContent).not.toContain('맥 앱은 맥에서 받아 주세요');
  });

  it('no forced flag: a Mac user agent draws the card (it drew nothing before this story)', async () => {
    setUA(MAC);
    const h = await draw();
    expect(h.querySelector('[data-testid="phone-app-card"]')).not.toBeNull();
    expect(h.querySelector('[data-testid="phone-app-scan-hint"]')).not.toBeNull();
    expect(h.querySelector('[data-testid="phone-app-mac-aux"]')).toBeNull();
  });

  it('iOS not open: the one «준비 중» line, no iOS link, no second QR (on a Mac and on a phone alike)', async () => {
    for (const elsewhere of [false, true]) {
      const h = await draw(elsewhere);
      expect(h.querySelector('[data-testid="phone-app-ios-soon"]')?.textContent).toBe('아이폰 · 준비 중이에요');
      expect(h.querySelectorAll('a').length).toBe(1);
      expect(h.querySelectorAll('svg').length).toBe(1);
      act(() => root.unmount()); root = createRoot(host);
    }
  });
});
