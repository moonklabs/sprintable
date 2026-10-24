// @vitest-environment jsdom
//
// story 4762 — «설정 › 이 폰»: the phone shows its own check number, the one the web's «원격 기기» list prints for that phone
// (desktop.remoteDevices.confirmNumberHint points here). The shell computes it (`device.key.info` → `key_number`, sha256 of the SPKI → first 4 bytes mod 1e6, «### ###»);
// the card asks, shows what comes back verbatim, and does no computing. «324 642» is the shared contract vector (SPKI = the ASCII bytes of
// `sprintable-4762-check-number-vector`): backend/tests/test_4762_check_number_vector.py and the shell's lib/phoneCalls.test.js compute the same string.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';
import { PhoneBridgeContext } from '@/components/providers/phone-bridge-context';
import { ThisPhoneCard } from './this-phone-card';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

type Answer = { id: string; ok: boolean; code?: string; [k: string]: unknown };
async function draw(phoneCall: (type: string, args?: Record<string, unknown>) => Promise<Answer>, opts: { inPhoneApp?: boolean; messages?: typeof koMessages; locale?: string } = {}) {
  await act(async () => {
    root.render(
      <PhoneBridgeContext.Provider value={{ inPhoneApp: opts.inPhoneApp ?? true, phoneCall }}>
        <NextIntlClientProvider locale={opts.locale ?? 'ko'} messages={opts.messages ?? koMessages} timeZone="UTC"><ThisPhoneCard /></NextIntlClientProvider>
      </PhoneBridgeContext.Provider>,
    );
  });
  await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
  return host;
}
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`);
const answer = (extra: Partial<Answer>): Answer => ({ id: 'w1', ok: true, ...extra });

describe('[SID:4762] ThisPhoneCard — the phone\'s own check number', () => {
  it('asks the shell once (`device.key.info`) and shows the number it answers, verbatim, under the title', async () => {
    const call = vi.fn(async () => answer({ key_number: '324 642' }));
    await draw(call);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith('device.key.info', {});
    expect(q('this-phone-number')?.textContent).toBe('324 642'); // reverted (not drawn / altered) → fails
    expect(host.querySelector('h2')?.textContent).toBe(koMessages.settings.thisPhoneTitle);
  });

  it('the line under the number says what to compare with — and what to do while the phone is not paired yet (PO words, ko + en)', async () => {
    await draw(async () => answer({ key_number: '018 604' }));
    expect(q('this-phone-hint')?.textContent).toBe(koMessages.settings.thisPhoneHint);
    expect(koMessages.settings.thisPhoneHint).toContain('페어링한 뒤'); // the product's word for the phone connection (story 4644: never «짝»)
    expect(koMessages.settings.thisPhoneHint).not.toContain('짝');
    expect(koMessages.settings.thisPhoneHint).toContain('데스크톱 앱 › 원격 기기'); // where the list really is (Yuna copy review)
    expect(enMessages.settings.thisPhoneHint).toContain('pair it first');
    expect(enMessages.settings.thisPhoneHint).toContain('Remote devices');
    // the web list's own words are the same «폰 확인 숫자» (not another name for it)
    expect(koMessages.settings.thisPhoneTitle).toBe('폰 확인 숫자');
    expect(koMessages.desktop.remoteDevices.confirmNumber.replace('{number}', '').trim()).toBe(koMessages.settings.thisPhoneTitle);
  });

  it('under React StrictMode (the effect runs twice) the shell is still asked ONCE — asking can make the phone\'s key', async () => {
    const call = vi.fn(async () => answer({ key_number: '324 642' }));
    await act(async () => {
      root.render(
        <StrictMode>
          <PhoneBridgeContext.Provider value={{ inPhoneApp: true, phoneCall: call }}>
            <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="UTC"><ThisPhoneCard /></NextIntlClientProvider>
          </PhoneBridgeContext.Provider>
        </StrictMode>,
      );
    });
    await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
    expect(call).toHaveBeenCalledTimes(1); // reverted (a call per effect run) → 2
    expect(q('this-phone-number')?.textContent).toBe('324 642');
  });

  it('any refused answer — also the bridge\'s own «timeout» for a call that never came back — is a failed read with «read again», not «reading» for ever (no special case: one mapping for every refusal)', async () => {
    await draw(async () => answer({ ok: false, code: 'timeout' }));
    expect(q('this-phone-failed')).not.toBeNull();
    expect(q('this-phone-retry')).not.toBeNull();
    expect(q('this-phone-reading')).toBeNull();
  });

  it('while the shell has not answered: «reading», no number', async () => {
    await draw(() => new Promise<Answer>(() => undefined));
    expect(q('this-phone-reading')?.textContent).toBe(koMessages.settings.thisPhoneReading);
    expect(q('this-phone-number')).toBeNull();
  });

  it('a phone with no screen lock says so (no number, no retry)', async () => {
    await draw(async () => answer({ ok: false, code: 'no_screen_lock' }));
    expect(q('this-phone-no-screen-lock')?.textContent).toBe(koMessages.settings.thisPhoneNoScreenLock);
    expect(q('this-phone-number')).toBeNull();
    expect(q('this-phone-retry')).toBeNull();
  });

  it('a failed read — a refusal, a rejected call, or an answer that is not a «### ###» number — says so and offers «read again» (never draws a stray string as the number)', async () => {
    for (const call of [
      async () => answer({ ok: false, code: 'key_invalidated' }),
      async () => { throw new Error('bridge'); },
      async () => answer({ key_number: '324642' }),
      async () => answer({ key_number: '<b>324 642</b>' }),
      async () => answer({ key_number: 123456 }),
      async () => answer({}),
    ]) {
      await draw(call as never);
      expect(q('this-phone-failed')?.textContent, String(call)).toBe(koMessages.settings.thisPhoneFailed);
      expect(q('this-phone-number')).toBeNull();
      expect(q('this-phone-retry')).not.toBeNull();
    }
  });

  it('another bridge function (the claim changed) is asked afresh — the new one is called, and its failure replaces the old number (the pending-bridge test below pins that the OLD number is not shown while the new one waits)', async () => {
    const first = vi.fn(async () => answer({ key_number: '324 642' }));
    await draw(first);
    expect(q('this-phone-number')?.textContent).toBe('324 642');
    const second = vi.fn(async () => answer({ ok: false, code: 'key_invalidated' }));
    await draw(second);
    expect(second).toHaveBeenCalledTimes(1); // reverted (the first request is reused) → 0
    expect(q('this-phone-failed')).not.toBeNull();
    expect(q('this-phone-number')).toBeNull();
  });

  it('while another bridge function has not answered yet, the old one\'s number is not shown for it (reading, not a stale number)', async () => {
    await draw(vi.fn(async () => answer({ key_number: '324 642' })));
    expect(q('this-phone-number')?.textContent).toBe('324 642');
    await draw(vi.fn(() => new Promise<Answer>(() => undefined))); // the new bridge never answers
    expect(q('this-phone-reading')).not.toBeNull(); // reverted (the answer is keyed by the request only) → the old number stays
    expect(q('this-phone-number')).toBeNull();
  });

  it('«read again» while the second request has not answered yet shows «loading», not the first answer again', async () => {
    const call = vi.fn()
      .mockResolvedValueOnce(answer({ ok: false, code: 'failed' }))
      .mockImplementationOnce(() => new Promise<Answer>(() => undefined));
    await draw(call as never);
    expect(q('this-phone-failed')).not.toBeNull();
    await act(async () => { (q('this-phone-retry') as HTMLButtonElement).click(); });
    await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
    expect(call).toHaveBeenCalledTimes(2);
    expect(q('this-phone-reading')).not.toBeNull(); // reverted (the answer is not tied to its request number) → the old failure stays on screen
    expect(q('this-phone-failed')).toBeNull();
  });

  it('«read again» asks the shell again and then shows the number', async () => {
    const call = vi.fn()
      .mockResolvedValueOnce(answer({ ok: false, code: 'failed' }))
      .mockResolvedValueOnce(answer({ key_number: '324 642' }));
    await draw(call as never);
    expect(q('this-phone-failed')).not.toBeNull();
    await act(async () => { (q('this-phone-retry') as HTMLButtonElement).click(); });
    await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
    expect(call).toHaveBeenCalledTimes(2);
    expect(q('this-phone-number')?.textContent).toBe('324 642');
    expect(q('this-phone-failed')).toBeNull();
  });

  it('outside the phone app nothing is drawn and the bridge is not asked', async () => {
    const call = vi.fn(async () => answer({ key_number: '324 642' }));
    await draw(call, { inPhoneApp: false });
    expect(host.innerHTML).toBe('');
    expect(call).not.toHaveBeenCalled();
  });

  it('english words exist for every state (no key falls back to a raw key name)', async () => {
    for (const k of ['tabThisPhone', 'thisPhoneTitle', 'thisPhoneHint', 'thisPhoneReading', 'thisPhoneNoScreenLock', 'thisPhoneFailed', 'thisPhoneRetry'] as const) {
      expect(enMessages.settings[k], k).toBeTruthy();
      expect(koMessages.settings[k], k).toBeTruthy();
    }
    await draw(async () => answer({ ok: false, code: 'no_screen_lock' }), { messages: enMessages as never, locale: 'en' });
    expect(q('this-phone-no-screen-lock')?.textContent).toBe(enMessages.settings.thisPhoneNoScreenLock);
  });
});
