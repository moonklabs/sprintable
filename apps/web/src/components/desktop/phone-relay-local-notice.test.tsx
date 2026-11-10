// @vitest-environment jsdom
// story 4829 (공개 2-⑥ (나)) — the guidance that stands in for the phone-pairing / phone-control screens in local mode: the words (ko · en), no link, no button, and nothing fetched,
// so nothing can fail on it («오류 0»).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';
import { PhoneRelayLocalNotice } from './phone-relay-local-notice';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const fetchSpy = vi.fn();
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); fetchSpy.mockReset(); vi.stubGlobal('fetch', fetchSpy); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

async function draw(locale: 'ko' | 'en') {
  await act(async () => {
    root.render(<NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="UTC"><PhoneRelayLocalNotice /></NextIntlClientProvider>);
  });
  return host.querySelector('[data-testid="phone-relay-local-notice"]');
}

describe('[SID:4829] the local-mode guidance', () => {
  it('ko: says it works in hosted mode, and why (the phone goes through the Sprintable server on the internet)', async () => {
    const card = await draw('ko');
    expect(card?.textContent).toContain('폰으로 다루기는 호스팅 모드에서 쓸 수 있어요');
    expect(card?.textContent).toContain('인터넷에 있는 Sprintable 서버');
    expect(card?.textContent).not.toContain('중간 서버'); // an inside word, not one for the person
  });
  it('en: the same, in English', async () => {
    const card = await draw('en');
    expect(card?.textContent).toContain('works in hosted mode');
    expect(card?.textContent).toContain('Sprintable server on the internet');
    expect(card?.textContent).not.toContain('middle server');
  });
  it('no link, no button, and nothing fetched (no error can come from this screen)', async () => {
    const card = await draw('ko');
    expect(card?.querySelectorAll('a, button').length).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('the guidance has a Korean and an English line under the same key', () => {
    const ko = (koMessages as { desktop: { phoneRelayLocal: Record<string, string> } }).desktop.phoneRelayLocal;
    const en = (enMessages as { desktop: { phoneRelayLocal: Record<string, string> } }).desktop.phoneRelayLocal;
    expect(Object.keys(ko).sort()).toEqual(Object.keys(en).sort());
    for (const v of [...Object.values(ko), ...Object.values(en)]) expect(v.length).toBeGreaterThan(10);
  });
});
