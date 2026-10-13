// @vitest-environment jsdom
// [SID:4671] (UX-1 · U3 · PO 07:13Z · AC2): the store is not open, but the way in is set — the testers' group page and the Play
// internal-test opt-in page. Android is two rows (① group · ② opt-in, each QR + link), iOS is the «준비 중» line. ko and en. The page
// reads the settings; the test sets them.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

const OPTIN = 'https://play.google.com/apps/internaltest/4701234567890123456';
const GROUP = 'https://groups.google.com/g/sprintable-phone-testers';
vi.mock('@/lib/phone-app-store', async (orig) => ({
  ...(await orig<typeof import('@/lib/phone-app-store')>()),
  PHONE_APP_PUBLISHED: { android: false, ios: false },
  PHONE_APP_INVITE_ANDROID_TARGET: 'https://play.google.com/apps/internaltest/4701234567890123456',
  PHONE_APP_TEST_GROUP_TARGET: 'https://groups.google.com/g/sprintable-phone-testers',
}));
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: () => Promise.reject(new Error('not used here')) }));
vi.mock('@/hooks/use-flat-href', () => ({ useFlatHref: () => (href: string) => href }));
const { PhonePairing } = await import('./phone-pairing');
const { PhoneAppCard } = await import('./phone-app-card');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

async function draw(node: ReactNode, locale: 'ko' | 'en' = 'ko') {
  await act(async () => {
    root.render(<NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="UTC">{node}</NextIntlClientProvider>);
  });
  return host;
}

describe('[SID:4671] store closed, the way in set (group + opt-in page)', () => {
  it('/desktop/pair outside the app: ① the group page ② the opt-in page (each QR + link, in that order) · iOS «준비 중» · no store address', async () => {
    const h = await draw(<PhonePairing />);
    const block = h.querySelector('[data-testid="phone-app-get"]');
    expect(block).not.toBeNull();
    expect([...block!.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual([GROUP, OPTIN]);
    expect(block!.querySelectorAll('svg').length).toBe(2);
    for (const svg of block!.querySelectorAll('svg')) expect(svg.getAttribute('aria-hidden')).toBe('true'); // Yuna 5060: the link's words name the row
    const group = block!.querySelector('[data-testid="phone-app-link-android-group"]');
    const optin = block!.querySelector('[data-testid="phone-app-link-android"]');
    expect(group?.getAttribute('data-kind')).toBe('invite');
    expect(optin?.getAttribute('data-kind')).toBe('invite');
    // Yuna §D (ux1-copy-1013) words, letter for letter
    expect(group?.querySelector('a')?.textContent).toBe('안드로이드 ① · 테스터 그룹 가입');
    expect(optin?.querySelector('a')?.textContent).toBe('안드로이드 ② · 구글 플레이 테스트 참여 후 설치');
    const note = block!.querySelector('[data-testid="phone-app-invite-note"]');
    expect(note?.textContent).toBe('스토어 공개 전이라 두 단계예요 — ①에 가입해야 ②가 열려요');
    // the note right above the two rows · ① before ②
    expect(note!.compareDocumentPosition(group!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(group!.compareDocumentPosition(optin!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(block!.querySelector('[data-testid="phone-app-ios-soon"]')?.textContent).toBe('아이폰 · 준비 중이에요');
    expect(h.textContent).not.toContain('play.google.com/store');
  });

  it('en: the same rows in English (Yuna §D)', async () => {
    const h = await draw(<PhonePairing />, 'en');
    expect(h.querySelector('[data-testid="phone-app-invite-note"]')?.textContent).toBe('Before the store opens it takes two steps — ② opens only after you join ①');
    expect(h.querySelector('[data-testid="phone-app-link-android-group"] a')?.textContent).toBe("Android ① · Join the testers' group");
    expect(h.querySelector('[data-testid="phone-app-link-android"] a')?.textContent).toBe('Android ② · Join the Google Play test, then install');
    expect(h.querySelector('[data-testid="phone-app-ios-soon"]')?.textContent).toBe('iPhone · coming soon');
  });

  it('no note when the store row is drawn (the store is open · no two steps)', async () => {
    const store = await import('@/lib/phone-app-store');
    expect(store.phoneAppLinks({ android: true, ios: false }, store.PHONE_APP_STORE_ANDROID_DEV, null, null)[0]?.kind).toBe('store');
  });

  it('the onboarding card on a Mac: the same two rows + «scan with your phone» under the body · the note above the rows', async () => {
    const h = await draw(<PhoneAppCard elsewhere={false} />);
    expect([...h.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual([GROUP, OPTIN]);
    const hint = h.querySelector('[data-testid="phone-app-scan-hint"]');
    const note = h.querySelector('[data-testid="phone-app-invite-note"]');
    expect(hint?.textContent).toBe('폰 카메라로 QR을 찍으면 폰에서 열려요');
    expect(hint!.compareDocumentPosition(note!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(h.querySelector('[data-testid="phone-app-ios-soon"]')).not.toBeNull();
  });
  it('/desktop/pair outside the app (no body): no scan hint (the hint is the Mac card\'s)', async () => {
    const h = await draw(<PhonePairing />);
    expect(h.querySelector('[data-testid="phone-app-scan-hint"]')).toBeNull();
  });
});

describe('[SID:4671] half a path is no path · the way in goes before the store', () => {
  it('the opt-in page without the group (the group setting still empty): nothing is drawn', async () => {
    const store = await import('@/lib/phone-app-store');
    const links = store.phoneAppLinks({ android: false, ios: false }, store.PHONE_APP_STORE_ANDROID, OPTIN, null);
    expect(links).toEqual([]);
  });
  it('PO 5060: on the dev web (published = on the internal track) the two steps are drawn, not the store link a non-tester cannot open', async () => {
    const store = await import('@/lib/phone-app-store');
    const dev = store.phoneAppTarget('https://dev-app.sprintable.ai');
    const links = store.phoneAppLinks(dev.published, dev.android, OPTIN, GROUP);
    expect(links[0]).toEqual({ store: 'android', kind: 'invite', url: OPTIN, group: GROUP });
    expect(links.some((l) => l.url === store.PHONE_APP_STORE_ANDROID_DEV)).toBe(false);
  });
});
