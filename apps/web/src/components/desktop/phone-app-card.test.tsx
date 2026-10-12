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
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

async function draw(elsewhere: boolean) {
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="UTC"><PhoneAppCard elsewhere={elsewhere} /></NextIntlClientProvider>);
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

  it('a Mac: nothing is drawn (the Mac app card stays alone on the page)', async () => {
    const h = await draw(false);
    expect(h.innerHTML).toBe('');
  });
});
