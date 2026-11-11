// @vitest-environment jsdom
//
// story 4891 (UI-8 · settings › 이 폰 · piece ③) — «이 폰» card on ds parts: the check number keeps its test ids and text; the card is a ds Card with the title as h2, «다시 읽기» is a ds Button (touch 44).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { PhoneBridgeContext } from '@/components/providers/phone-bridge-context';
import { ThisPhoneCard } from './this-phone-card';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

type Answer = { id: string; ok: boolean; code?: string; [k: string]: unknown };
async function draw(phoneCall: () => Promise<Answer>) {
  await act(async () => {
    root.render(
      <PhoneBridgeContext.Provider value={{ inPhoneApp: true, phoneCall }}>
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="UTC"><ThisPhoneCard /></NextIntlClientProvider>
      </PhoneBridgeContext.Provider>,
    );
  });
  await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
}

describe('[SID:4891] ThisPhoneCard on ds parts', () => {
  it('the number state: a ds card (test id kept), the title is the h2, the number is verbatim', async () => {
    await draw(async () => ({ id: 'w', ok: true, key_number: '324 642' }));
    const card = host.querySelector('[data-testid="this-phone-card"]')!;
    expect(card.getAttribute('data-slot')).toBe('ds-card');
    expect(card.querySelector('h2')?.textContent).toBe(koMessages.settings.thisPhoneTitle);
    expect(host.querySelector('[data-testid="this-phone-number"]')?.textContent).toBe('324 642');
    expect(card.querySelector('button')).toBeNull(); // nothing to press while it reads fine
  });

  it('the failed state: «다시 읽기» is a ds Button (touch floor 44) and pressing it asks the shell again', async () => {
    let n = 0;
    await draw(async () => (++n === 1 ? { id: 'w', ok: false, code: 'timeout' } : { id: 'w', ok: true, key_number: '018 604' }));
    const retry = host.querySelector('[data-testid="this-phone-retry"]') as HTMLButtonElement;
    expect(retry.getAttribute('data-slot')).toBe('ds-button');
    expect(retry.className).toContain('pointer-coarse:min-h-11');
    await act(async () => { retry.click(); });
    await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
    expect(n).toBe(2);
    expect(host.querySelector('[data-testid="this-phone-number"]')?.textContent).toBe('018 604');
  });
});
