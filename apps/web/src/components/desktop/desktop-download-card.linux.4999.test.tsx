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
const LINUX = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const LINUX_ARM = 'Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const CHROMEOS = 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
let ua = LINUX;
let inPhoneApp = false;
// story #4661: the phone state is subscribable — a test plays the claim by flipping it and telling the listeners
const phoneListeners = vi.hoisted(() => new Set<() => void>());
vi.mock('@/lib/phone-bridge', () => ({
  isPhoneApp: () => inPhoneApp,
  claimPhoneBridge: () => {},
  phoneCall: async () => ({ id: '', ok: false, code: 'not_phone_app' }),
  subscribePhoneApp: (listen: () => void) => { phoneListeners.add(listen); return () => { phoneListeners.delete(listen); }; },
}));
const { DesktopDownloadCard, isLinuxBrowser, otherPlatformOf } = await import('./desktop-download-card');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode, locale: 'ko' | 'en' = 'ko') {
  return <PhoneBridgeClaim><NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="UTC">{node}</NextIntlClientProvider></PhoneBridgeClaim>;
}

beforeEach(() => {
  ua = LINUX;
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

// [SID:4999] the Linux download in the card — only a Linux desktop browser asks for the Linux manifest (Android · ChromeOS · Arm Linux · a Mac · Windows · the phone app never do); no Windows first-open guide is ever drawn for Linux, whatever `signed` says.
const MAC_MANIFEST = {
  product: 'Sprintable Dev Setup', version: '0.2.0', build: 'abc123def', notarized: true,
  url: 'https://storage.googleapis.com/sprintable-desktop-releases-dev/macos-electron/0.2.0/Sprintable-Dev-Setup-abc123def-arm64.dmg',
};
const LINUX_MANIFEST = {
  product: 'Sprintable', platform: 'linux-x64', version: '0.2.311', build: '88a5ecb5f', signed: false, size: 1,
  url: 'https://storage.googleapis.com/sprintable-desktop-releases-dev/linux-electron/0.2.311/Sprintable-0.2.311-linux-x86_64.AppImage',
  deb_url: 'https://storage.googleapis.com/sprintable-desktop-releases-dev/linux-electron/0.2.311/Sprintable-0.2.311-linux-amd64.deb',
};
const answering = (answers: Record<string, unknown>) => vi.fn(async (url: string) => (url in answers ? jsonResponse(answers[url]) : jsonResponse(null, false)));
const text = (id: string) => container.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;

describe('DesktopDownloadCard — [SID:4999] the Linux download', () => {
  it('a Linux desktop browser: the card gives the AppImage (the url from its own manifest · version · build · target), not the «open on a Mac» line, and no Windows guide', async () => {
    const fetchMock = answering({ '/desktop/downloads/macos.json': MAC_MANIFEST, '/desktop/downloads/linux.json': LINUX_MANIFEST });
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => { root.render(wrap(<DesktopDownloadCard />, 'en')); });
    await flush();
    const a = container.querySelector('[data-testid="desktop-download-linux-button"] a, a[data-testid="desktop-download-linux-button"]') as HTMLAnchorElement;
    expect(a.getAttribute('href')).toBe(LINUX_MANIFEST.url); // (the AppImage — never the deb)
    expect(a.textContent).toBe(enMessages.desktop.linuxDownloadCta);
    expect(text('desktop-download-linux-target')).toBe(enMessages.desktop.linuxTarget);
    expect(text('desktop-download-version')).toContain('0.2.311');
    expect(container.querySelector('[data-testid="desktop-download-open-on-mac"]')).toBeNull();
    expect(container.querySelector('[data-testid="desktop-download-windows-unsigned-notice"]')).toBeNull(); // (signed:false is Windows' guide only)
    expect(fetchMock.mock.calls.map((c) => String((c as unknown[])[0])).sort()).toEqual(['/desktop/downloads/linux.json', '/desktop/downloads/macos.json']);
  });

  it('ko strings are the Linux ones (대상 Linux (64비트) · Linux용 받기)', async () => {
    vi.stubGlobal('fetch', answering({ '/desktop/downloads/macos.json': MAC_MANIFEST, '/desktop/downloads/linux.json': LINUX_MANIFEST }));
    await act(async () => { root.render(wrap(<DesktopDownloadCard />, 'ko')); });
    await flush();
    expect(text('desktop-download-linux-target')).toBe(koMessages.desktop.linuxTarget);
    expect(container.querySelector('[data-testid="desktop-download-linux-button"]')?.textContent).toBe(koMessages.desktop.linuxDownloadCta);
  });

  it('no Linux manifest yet (404) or a url outside our bucket: no invented link — the card says what it said before (open on a Mac)', async () => {
    vi.stubGlobal('fetch', answering({ '/desktop/downloads/macos.json': MAC_MANIFEST }));
    await act(async () => { root.render(wrap(<DesktopDownloadCard />)); });
    await flush();
    expect(container.querySelector('[data-testid="desktop-download-linux-button"]')).toBeNull();
    expect(container.querySelector('[data-testid="desktop-download-open-on-mac"]')).not.toBeNull();
    await act(async () => { root.unmount(); }); root = createRoot(container);
    vi.stubGlobal('fetch', answering({ '/desktop/downloads/macos.json': MAC_MANIFEST, '/desktop/downloads/linux.json': { ...LINUX_MANIFEST, url: 'https://storage.googleapis.com/sprintable-desktop-releases-dev-evil/x.AppImage' } }));
    await act(async () => { root.render(wrap(<DesktopDownloadCard />)); });
    await flush();
    expect(container.querySelector('[data-testid="desktop-download-linux-button"]')).toBeNull();
  });

  it('a Mac · a phone · Android · ChromeOS · an Arm Linux · inside the phone app never ask for the Linux manifest', async () => {
    for (const [who, phone] of [[MAC, false], [IPHONE, false], [ANDROID, false], [CHROMEOS, false], [LINUX_ARM, false], [LINUX, true]] as const) {
      ua = who; inPhoneApp = phone;
      const fetchMock = answering({ '/desktop/downloads/macos.json': MAC_MANIFEST, '/desktop/downloads/linux.json': LINUX_MANIFEST });
      vi.stubGlobal('fetch', fetchMock);
      await act(async () => { root.render(wrap(<DesktopDownloadCard />)); });
      await flush();
      expect(fetchMock.mock.calls.map((c) => String((c as unknown[])[0])), who).toEqual(['/desktop/downloads/macos.json']);
      expect(container.querySelector('[data-testid="desktop-download-linux-button"]')).toBeNull();
      await act(async () => { root.unmount(); }); root = createRoot(container);
    }
  });

  it('a late phone claim drops the Linux block', async () => {
    vi.stubGlobal('fetch', answering({ '/desktop/downloads/macos.json': MAC_MANIFEST, '/desktop/downloads/linux.json': LINUX_MANIFEST }));
    await act(async () => { root.render(wrap(<DesktopDownloadCard />)); });
    await flush();
    expect(container.querySelector('[data-testid="desktop-download-linux-button"]')).not.toBeNull();
    inPhoneApp = true; await act(async () => { for (const l of phoneListeners) l(); });
    await flush();
    expect(container.querySelector('[data-testid="desktop-download-linux-button"]')).toBeNull();
  });

  it('isLinuxBrowser · otherPlatformOf: a Linux x86 desktop only; Windows is Windows', () => {
    expect(isLinuxBrowser(LINUX, false)).toBe(true);
    for (const u of [MAC, WINDOWS, IPHONE, ANDROID, CHROMEOS, LINUX_ARM]) expect(isLinuxBrowser(u, false), u).toBe(false);
    expect(isLinuxBrowser(LINUX, true)).toBe(false);
    expect(otherPlatformOf(WINDOWS, false)).toBe('windows'); expect(otherPlatformOf(LINUX, false)).toBe('linux'); expect(otherPlatformOf(MAC, false)).toBeNull();
  });
});
