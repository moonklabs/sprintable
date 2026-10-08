// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

// story #4547: the card tells a Mac from anything else — jsdom's own user agent («(darwin|linux) … jsdom») is no Mac's, so each case
// says which device it is (a Mac by default: the suite below is the Mac card)
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
let ua = MAC;
let inPhoneApp = false;
vi.mock('@/lib/phone-bridge', () => ({ isPhoneApp: () => inPhoneApp }));
const { DesktopDownloadCard, notAMac } = await import('./desktop-download-card');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode, locale: 'ko' | 'en' = 'ko') {
  return <NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="UTC">{node}</NextIntlClientProvider>;
}

beforeEach(() => {
  ua = MAC;
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

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

// story #3807 AC3(페드루 PO 確定 2026-09-11 · 착수 시점 민 AC2 PR 0건) — 민의
// `/desktop/updates/macos.json`이 아직 없어 fetch가 실패하는 게 지금은 정상. 이
// 스위트는 그 실패가 «막다른 침묵»이 아니라 정직한 안내 문구로 뜨는지 고정하고
// (페드루 PO 정정, 2026-09-11 16:02Z 캡처 실측), 매니페스트가 실제로 오면
// 버전·빌드 sha·공증 문구·다운로드 링크가 정확히 뜨는지를 함께 고정한다.
describe('DesktopDownloadCard — story #3807 AC3', () => {
  it('⭐매니페스트를 못 읽으면(민 AC2 미착지·404 등) 지어낸 버전·링크 0·「지금은 받을 수 없습니다」로 정직하게 말한다(완전 침묵 금지, 페드루 PO 정정)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(null, false)));
    await act(async () => { root.render(wrap(<DesktopDownloadCard />)); });
    await flush();
    expect(container.querySelector('[data-testid="desktop-download-unavailable"]')?.textContent)
      .toBe(koMessages.desktop.unavailable);
    expect(container.querySelector('[data-testid="desktop-download-version"]')).toBeNull();
    expect(container.querySelector('[data-testid="desktop-download-button"]')).toBeNull();
  });

  it('네트워크 예외(fetch 자체가 throw)도 같은 안내 문구로 조용히 흡수한다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    await act(async () => { root.render(wrap(<DesktopDownloadCard />)); });
    await flush();
    expect(container.querySelector('[data-testid="desktop-download-unavailable"]')?.textContent)
      .toBe(koMessages.desktop.unavailable);
  });

  // [SID:4619] — the card reads the Electron app's manifest (/desktop/downloads/macos.json), never the old Tauri updater's
  const MANIFEST = {
    product: 'Sprintable Dev Setup', bundle_id: 'ai.sprintable.desktop.dev.setup', version: '0.2.0', build: 'abc123def',
    url: 'https://storage.googleapis.com/sprintable-desktop-releases-dev/macos-electron/0.2.0/Sprintable-Dev-Setup-abc123def-arm64.dmg',
    sha256: 'f'.repeat(64), size: 1, signed_team: 'JN798BC4KC', notarized: false, pub_date: '2026-10-08T03:00:00.000Z',
  };

  it('⭐[SID:4619] 매니페스트 수신 — 대상 · 버전 · 빌드 · 첫 열기 안내(유나 정본: 제목 · 순서 두 줄 · macOS 12 덧줄 · 공증 전) · DMG 링크', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(MANIFEST));
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => { root.render(wrap(<DesktopDownloadCard />)); });
    await flush();

    // the Electron app's manifest, not the old Tauri updater's (installed old apps keep updating from that one)
    expect(fetchMock.mock.calls.map((c) => String((c as unknown[])[0]))).toEqual(['/desktop/downloads/macos.json']);
    expect(container.querySelector('[data-testid="desktop-download-target"]')?.textContent).toBe(koMessages.desktop.targetLabel);
    expect(container.querySelector('[data-testid="desktop-download-version"]')?.textContent).toBe('버전 0.2.0');
    // Yuna 04:0xZ: the app's name (as macOS says it when it blocks) leads the line — «Sprintable Dev Setup · 버전 0.2.0 · 빌드 …»
    expect(container.querySelector('[data-testid="desktop-download-version"]')?.parentElement?.textContent).toBe('Sprintable Dev Setup · 버전 0.2.0 · 빌드 abc123def');
    // the settings panel's name in one piece (nowrap) — the step reads whole
    const panel = container.querySelector('[data-testid="desktop-download-settings-panel"]');
    expect(panel?.textContent).toBe('개인정보 보호 및 보안');
    expect(panel?.className.split(' ')).toContain('whitespace-nowrap');
    expect(container.querySelector('[data-testid="desktop-download-build-sha"]')?.textContent).toBe(' · 빌드 abc123def');
    expect(container.querySelector('[data-testid="desktop-download-gatekeeper-title"]')?.textContent)
      .toBe('처음 열면 macOS가 막아요 — 한 번만 이렇게 열어 주세요');
    expect([...container.querySelectorAll('[data-testid="desktop-download-install-steps"] > li')].map((e) => e.textContent)).toEqual([
      '받은 파일을 열어 앱을 「응용 프로그램」 폴더로 끌어 놓아요',
      '앱을 한 번 열어 본 뒤 시스템 설정 → 개인정보 보호 및 보안 → 「그래도 열기」',
    ]);
    expect(container.querySelector('[data-testid="desktop-download-old-mac"]')?.textContent).toBe('macOS 12에서는 앱을 우클릭 → 「열기」');
    // no block inside a <p> (Yuna 5004: AlertDescription is a <p>) — the list and its lines sit in a div
    expect(container.querySelector('p ol, p p')).toBeNull();
    expect(container.querySelector('[data-testid="desktop-download-notarization-notice"]')?.textContent).toBe('Apple 공증 전 내부용이에요.');
    const link = container.querySelector('[data-testid="desktop-download-button"]') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(MANIFEST.url);
    expect(link.hasAttribute('download')).toBe(true);
  });

  it('[SID:4619] a manifest without a product name: the line as before («버전 … · 빌드 …», no name)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ...MANIFEST, product: '' })));
    await act(async () => { root.render(wrap(<DesktopDownloadCard />)); });
    await flush();
    expect(container.querySelector('[data-testid="desktop-download-product"]')).toBeNull();
    expect(container.querySelector('[data-testid="desktop-download-version"]')?.parentElement?.textContent).toBe('버전 0.2.0 · 빌드 abc123def');
  });

  it('[SID:4619] the old right-click line is gone — its key in neither locale, nothing reads it', async () => {
    const en = (await import('../../../messages/en.json')).default as { desktop: Record<string, unknown> };
    expect('gatekeeperNotice' in koMessages.desktop).toBe(false);
    expect('gatekeeperNotice' in en.desktop).toBe(false);
    expect(en.desktop.installStepOpen).toBe('Try opening the app once, then go to System Settings → <nw>Privacy & Security</nw> → "Open Anyway"');
    expect(koMessages.desktop.installStepOpen).toBe('앱을 한 번 열어 본 뒤 시스템 설정 → <nw>개인정보 보호 및 보안</nw> → 「그래도 열기」');
  });

  it('[SID:4619 · Kadir 5004 후속 ①] a manifest whose url is not our bucket is «지금은 받을 수 없어요» — no link to it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ...MANIFEST, url: 'https://storage.googleapis.com/sprintable-desktop-releases-dev-evil/x.dmg' })));
    await act(async () => { root.render(wrap(<DesktopDownloadCard />)); });
    await flush();
    expect(container.querySelector('[data-testid="desktop-download-unavailable"]')?.textContent).toBe(koMessages.desktop.unavailable);
    expect(container.querySelector('[data-testid="desktop-download-button"]')).toBeNull();
    expect(container.innerHTML.includes('dev-evil')).toBe(false);
  });

  it('[SID:4619] a manifest without a url (or the old Tauri shape) is «지금은 받을 수 없어요», not a broken button', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ version: '0.1.2', platforms: { 'darwin-aarch64': { url: 'https://x/Sprintable.app.tar.gz', signature: 's' } } })));
    await act(async () => { root.render(wrap(<DesktopDownloadCard />)); });
    await flush();
    expect(container.querySelector('[data-testid="desktop-download-unavailable"]')?.textContent).toBe(koMessages.desktop.unavailable);
    expect(container.querySelector('[data-testid="desktop-download-button"]')).toBeNull();
  });
});

describe('[4547] not a Mac — one line where the warning and [다운로드] were (Yuna 4547-phone-download-card.md · spec «4524 곁»)', () => {
  // [SID:4619] the Electron app's manifest shape (/desktop/downloads/macos.json) — the url inside our bucket (5005's link guard)
  const manifest = () => vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
    product: 'Sprintable Dev Setup', version: '0.3.1', build: 'abc123def',
    url: 'https://storage.googleapis.com/sprintable-desktop-releases-dev/macos-electron/0.3.1/Sprintable-Dev-Setup-abc123def-arm64.dmg',
  })));
  /** 4619's first-open guide box (its title · its two steps) and the button — the Mac-only part of the card */
  const macPart = () => ({ title: !!q('desktop-download-gatekeeper-title'), steps: !!q('desktop-download-install-steps'),
    oldMac: !!q('desktop-download-old-mac'), button: !!q('desktop-download-button') });
  const q = (id: string) => container.querySelector(`[data-testid="${id}"]`);
  async function show(locale: 'ko' | 'en' = 'ko') {
    await act(async () => { root.render(wrap(<DesktopDownloadCard />, locale)); });
    await flush();
  }

  it('the device decides: iPhone · Android · Windows · the phone app → not a Mac; a Mac (a narrow window too) · iPadOS (reports «Macintosh») → a Mac', () => {
    expect([IPHONE, ANDROID, WINDOWS].map((u) => notAMac(u, false))).toEqual([true, true, true]);
    expect(notAMac(MAC, true)).toBe(true); // inside the phone app's shell, whatever it reports
    expect(notAMac(MAC, false)).toBe(false);
  });

  it('a phone: title · target · version stay · no first-open guide box (4619) · no button · the one muted line · no link', async () => {
    ua = IPHONE;
    manifest();
    await show();
    expect(q('desktop-download-target')?.textContent).toBe(koMessages.desktop.targetLabel);
    expect(q('desktop-download-version')?.textContent).toBe('버전 0.3.1');
    expect(macPart()).toEqual({ title: false, steps: false, oldMac: false, button: false });
    const line = q('desktop-download-open-on-mac');
    expect(line?.textContent).toBe('Mac에서 이 화면을 열어 받아 주세요');
    expect(line?.className).toContain('text-muted-foreground');
    expect(q('desktop-download-card')?.querySelector('a, button')).toBeNull();
  });

  it('a phone never paints the Mac card, not for one frame — every DOM change on the way in is checked (Yuna: the device is known when «loading» ends)', async () => {
    ua = IPHONE;
    manifest();
    let macSeen = false;
    const seen = new MutationObserver(() => {
      if (q('desktop-download-button') || q('desktop-download-gatekeeper-notice')) macSeen = true;
    });
    seen.observe(container, { childList: true, subtree: true });
    await show();
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); // a later task too: a device read after «loading» ends shows here
    seen.disconnect();
    expect(q('desktop-download-open-on-mac')).not.toBeNull();
    expect(macSeen).toBe(false);
  });

  it('inside the phone app (its shell) the same, even with a Mac-looking user agent', async () => {
    inPhoneApp = true;
    manifest();
    await show();
    expect(q('desktop-download-button')).toBeNull();
    expect(q('desktop-download-open-on-mac')).not.toBeNull();
  });

  it('a Mac in a 390 px window keeps [다운로드] and the whole first-open guide box (4619) — the width never decides (negative control)', async () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(390);
    manifest();
    await show();
    expect(macPart()).toEqual({ title: true, steps: true, oldMac: true, button: true });
    expect(q('desktop-download-open-on-mac')).toBeNull();
  });

  it('the manifest not read × a phone: the «not available» line, not «open on your Mac» (a Mac could not get it either)', async () => {
    ua = ANDROID;
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(null, false)));
    await show();
    expect(q('desktop-download-unavailable')?.textContent).toBe(koMessages.desktop.unavailable);
    expect(q('desktop-download-open-on-mac')).toBeNull();
  });

  it('reads in English', async () => {
    ua = IPHONE;
    manifest();
    await show('en');
    expect(q('desktop-download-open-on-mac')?.textContent).toBe('Open this page on your Mac to download');
  });
});
