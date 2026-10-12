// @vitest-environment jsdom
// story 4654 — on the dev web the phone app card links the dev Android package (the testers install from it); production shows no card.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { PHONE_APP_STORE_ANDROID_DEV } from '@/lib/phone-app-store';

vi.mock('@/lib/phone-app-store', async (orig) => {
  const { phoneAppTarget } = await orig<typeof import('@/lib/phone-app-store')>();
  const dev = phoneAppTarget('https://dev-app.sprintable.ai');
  return { ...(await orig<typeof import('@/lib/phone-app-store')>()), PHONE_APP_PUBLISHED: dev.published, PHONE_APP_STORE_ANDROID_TARGET: dev.android };
});
const { PhoneAppCard } = await import('./phone-app-card');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('[SID:4654] the phone app card on the dev web', () => {
  it('shows the dev package link under the aux line', async () => {
    await act(async () => {
      root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="UTC"><PhoneAppCard elsewhere /></NextIntlClientProvider>);
    });
    expect([...host.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual([PHONE_APP_STORE_ANDROID_DEV]);
  });
});
