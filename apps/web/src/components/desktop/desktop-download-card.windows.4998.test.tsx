// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';
import { PhoneBridgeClaim } from '@/components/providers/phone-bridge-claim';

// story #4547: the card tells a Mac from anything else — jsdom's own user agent («(darwin|linux) … jsdom») is no Mac's, so each case
// says which device it is (a Mac by default: the suite below is the Mac card)
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
let ua = WINDOWS;
let inPhoneApp = false;
// story #4661: the phone state is subscribable — a test plays the claim by flipping it and telling the listeners
const phoneListeners = vi.hoisted(() => new Set<() => void>());
vi.mock('@/lib/phone-bridge', () => ({
  isPhoneApp: () => inPhoneApp,
  claimPhoneBridge: () => {},
  phoneCall: async () => ({ id: '', ok: false, code: 'not_phone_app' }),
  subscribePhoneApp: (listen: () => void) => { phoneListeners.add(listen); return () => { phoneListeners.delete(listen); }; },
}));
const { DesktopDownloadCard, isWindowsBrowser } = await import('./desktop-download-card');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode, locale: 'ko' | 'en' = 'ko') {
  return <PhoneBridgeClaim><NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="UTC">{node}</NextIntlClientProvider></PhoneBridgeClaim>;
}

beforeEach(() => {
  ua = WINDOWS;
  inPhoneApp = false;
  vi.spyOn(navigator, 'userAgent', 'get').mockImplementation(() => ua);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

// story 4696: the manifest route tells the card its bucket in a header (the server's own setting)
const DEV_BUCKET = 'sprintable-desktop-releases-dev';
function jsonResponse(body: unknown, ok = true, bucket: string | null = DEV_BUCKET) {
  return { ok, json: async () => body, headers: new Headers(bucket ? { 'x-desktop-download-bucket': bucket } : {}) } as Response;
}

// [SID:4998] the Windows download in the card — only a Windows browser asks for the Windows installer's manifest; the first-open guide shows only while the manifest says `signed: false`.
const MAC_MANIFEST = {
  product: 'Sprintable Dev Setup', version: '0.2.0', build: 'abc123def', notarized: true,
  url: 'https://storage.googleapis.com/sprintable-desktop-releases-dev/macos-electron/0.2.0/Sprintable-Dev-Setup-abc123def-arm64.dmg',
};
const WIN_MANIFEST = {
  product: 'Sprintable', platform: 'windows-x64', version: '0.2.310', build: 'bfe209089', signed: false, signature_status: 'NotSigned',
  url: 'https://storage.googleapis.com/sprintable-desktop-releases-dev/windows-electron/0.2.310/Sprintable-Setup-0.2.310-win-x64.exe',
};
/** both routes answer their own manifest (a route that is not in `answers` is a 404) */
const answering = (answers: Record<string, unknown>) => vi.fn(async (url: string) => (url in answers ? jsonResponse(answers[url]) : jsonResponse(null, false)));
const text = (id: string) => container.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;

describe('DesktopDownloadCard — [SID:4998] the Windows download', () => {
  it('a Windows browser: the card gives the Windows installer (the url from its own manifest · version · build · target), not the «open on a Mac» line', async () => {
    const fetchMock = answering({ '/desktop/downloads/macos.json': MAC_MANIFEST, '/desktop/downloads/windows.json': WIN_MANIFEST });
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => { root.render(wrap(<DesktopDownloadCard />, 'en')); });
    await flush();
    const a = container.querySelector('[data-testid="desktop-download-windows-button"] a, a[data-testid="desktop-download-windows-button"]') as HTMLAnchorElement;
    expect(a.getAttribute('href')).toBe(WIN_MANIFEST.url);
    expect(a.textContent).toBe(enMessages.desktop.windowsDownloadCta);
    expect(text('desktop-download-windows-target')).toBe(enMessages.desktop.windowsTarget);
    expect(text('desktop-download-version')).toContain('0.2.310');
    expect(container.querySelector('[data-testid="desktop-download-open-on-mac"]')).toBeNull();
    expect(container.querySelector('[data-testid="desktop-download-button"]')).toBeNull(); // (the Mac's button is not drawn for a Windows computer)
    expect(fetchMock.mock.calls.map((c) => String((c as unknown[])[0])).sort()).toEqual(['/desktop/downloads/macos.json', '/desktop/downloads/windows.json']);
  });

  it('the first-open guide is under the button while the manifest says signed:false — en and ko, exactly the agreed words (More info → Run anyway · 추가 정보 → 실행)', async () => {
    vi.stubGlobal('fetch', answering({ '/desktop/downloads/macos.json': MAC_MANIFEST, '/desktop/downloads/windows.json': WIN_MANIFEST }));
    await act(async () => { root.render(wrap(<DesktopDownloadCard />, 'en')); });
    await flush();
    const en = text('desktop-download-windows-unsigned-notice');
    expect(en).toBe(enMessages.desktop.windowsUnsignedNotice);
    expect(en).toContain('Windows protected your PC'); expect(en).toContain('More info'); expect(en).toContain('Run anyway');
    await act(async () => { root.unmount(); }); root = createRoot(container);
    vi.stubGlobal('fetch', answering({ '/desktop/downloads/macos.json': MAC_MANIFEST, '/desktop/downloads/windows.json': WIN_MANIFEST }));
    await act(async () => { root.render(wrap(<DesktopDownloadCard />, 'ko')); });
    await flush();
    const ko = text('desktop-download-windows-unsigned-notice');
    expect(ko).toBe(koMessages.desktop.windowsUnsignedNotice);
    expect(ko).toContain('Windows의 PC 보호'); expect(ko).toContain('추가 정보'); expect(ko).toContain('실행');
    // the guide comes AFTER the button in the card (just under it)
    const html = container.innerHTML;
    expect(html.indexOf('desktop-download-windows-button')).toBeLessThan(html.indexOf('desktop-download-windows-unsigned-notice'));
  });

  it('a signed build (signed:true) · a manifest with no signed field: no guide (it disappears by itself — and an old manifest is never taken for «unsigned»)', async () => {
    for (const m of [{ ...WIN_MANIFEST, signed: true, signature_status: 'Valid' }, { ...WIN_MANIFEST, signed: undefined }]) {
      vi.stubGlobal('fetch', answering({ '/desktop/downloads/macos.json': MAC_MANIFEST, '/desktop/downloads/windows.json': m }));
      await act(async () => { root.render(wrap(<DesktopDownloadCard />)); });
      await flush();
      expect(container.querySelector('[data-testid="desktop-download-windows-button"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="desktop-download-windows-unsigned-notice"]')).toBeNull();
      await act(async () => { root.unmount(); }); root = createRoot(container);
    }
  });

  it('no Windows manifest yet (404) or a url outside our bucket: no invented link — the card says what it said before (open on a Mac)', async () => {
    vi.stubGlobal('fetch', answering({ '/desktop/downloads/macos.json': MAC_MANIFEST }));
    await act(async () => { root.render(wrap(<DesktopDownloadCard />)); });
    await flush();
    expect(container.querySelector('[data-testid="desktop-download-windows-button"]')).toBeNull();
    expect(container.querySelector('[data-testid="desktop-download-open-on-mac"]')).not.toBeNull();
    await act(async () => { root.unmount(); }); root = createRoot(container);
    vi.stubGlobal('fetch', answering({ '/desktop/downloads/macos.json': MAC_MANIFEST, '/desktop/downloads/windows.json': { ...WIN_MANIFEST, url: 'https://storage.googleapis.com/sprintable-desktop-releases-dev-evil/x.exe' } }));
    await act(async () => { root.render(wrap(<DesktopDownloadCard />)); });
    await flush();
    expect(container.querySelector('[data-testid="desktop-download-windows-button"]')).toBeNull();
  });

  it('a Mac · a phone · inside the phone app never ask for the Windows manifest (the existing cards are exactly what they were)', async () => {
    for (const [who, phone] of [[MAC, false], [IPHONE, false], [ANDROID, false], [WINDOWS, true]] as const) {
      ua = who; inPhoneApp = phone;
      const fetchMock = answering({ '/desktop/downloads/macos.json': MAC_MANIFEST, '/desktop/downloads/windows.json': WIN_MANIFEST });
      vi.stubGlobal('fetch', fetchMock);
      await act(async () => { root.render(wrap(<DesktopDownloadCard />)); });
      await flush();
      expect(fetchMock.mock.calls.map((c) => String((c as unknown[])[0]))).toEqual(['/desktop/downloads/macos.json']);
      expect(container.querySelector('[data-testid="desktop-download-windows-button"]')).toBeNull();
      await act(async () => { root.unmount(); }); root = createRoot(container);
    }
  });

  it('isWindowsBrowser: a Windows NT browser outside the phone app only', () => {
    expect(isWindowsBrowser(WINDOWS, false)).toBe(true);
    expect(isWindowsBrowser(WINDOWS, true)).toBe(false);
    for (const u of [MAC, IPHONE, ANDROID]) expect(isWindowsBrowser(u, false)).toBe(false);
  });
});
