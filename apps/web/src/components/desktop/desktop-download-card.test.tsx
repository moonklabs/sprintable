// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { DesktopDownloadCard } from './desktop-download-card';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="UTC">{node}</NextIntlClientProvider>;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
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
