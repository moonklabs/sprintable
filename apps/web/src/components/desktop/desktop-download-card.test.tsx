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

  it('⭐매니페스트 수신 — 대상·버전·공증 문구·Gatekeeper 안내·다운로드 링크(GCS url)가 정확히 뜬다(빌드 sha 없는 순수 semver)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      version: '0.3.1', pub_date: '2026-09-11T00:00:00Z',
      platforms: { 'darwin-aarch64': { url: 'https://storage.googleapis.com/sprintable-desktop-releases-dev/macos/0.3.1/app.tar.gz', signature: 'sig' } },
    })));
    await act(async () => { root.render(wrap(<DesktopDownloadCard />)); });
    await flush();

    const card = container.querySelector('[data-testid="desktop-download-card"]');
    expect(card).not.toBeNull();
    // 페드루 PO 정정 2(2026-09-11 16:13Z) — 대상 플랫폼·Gatekeeper 우회 안내.
    expect(container.querySelector('[data-testid="desktop-download-target"]')?.textContent)
      .toBe(koMessages.desktop.targetLabel);
    expect(container.querySelector('[data-testid="desktop-download-gatekeeper-notice"]')?.textContent)
      .toBe(koMessages.desktop.gatekeeperNotice);
    expect(container.querySelector('[data-testid="desktop-download-version"]')?.textContent).toBe('버전 0.3.1');
    expect(container.querySelector('[data-testid="desktop-download-build-sha"]')).toBeNull();
    expect(container.querySelector('[data-testid="desktop-download-notarization-notice"]')?.textContent)
      .toBe(koMessages.desktop.notarizationNotice);
    const link = container.querySelector('[data-testid="desktop-download-button"]') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://storage.googleapis.com/sprintable-desktop-releases-dev/macos/0.3.1/app.tar.gz');
    expect(link.hasAttribute('download')).toBe(true);
  });

  it('version이 semver+build 형식(예: "0.3.1+a1b2c3d")이면 「+」 뒤를 빌드 sha로 따로 보인다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      version: '0.3.1+a1b2c3d', pub_date: '2026-09-11T00:00:00Z',
      platforms: { 'darwin-aarch64': { url: 'https://storage.googleapis.com/x/app.tar.gz', signature: 'sig' } },
    })));
    await act(async () => { root.render(wrap(<DesktopDownloadCard />)); });
    await flush();

    expect(container.querySelector('[data-testid="desktop-download-version"]')?.textContent).toBe('버전 0.3.1+a1b2c3d');
    expect(container.querySelector('[data-testid="desktop-download-build-sha"]')?.textContent).toBe(' · 빌드 a1b2c3d');
  });
});
