// @vitest-environment jsdom
//
// story #4012(critical·prod 승격 준비) AC3 — `/desktop` 서버 컴포넌트 게이트 배선.
// 판정 자체(값이 정확히 "true"일 때만 켜짐)는 desktop-download-gate.test.ts가 pin —
// 여기는 그 판정이 실제로 redirect()/카드 렌더로 이어지는지만 pin한다.
// DesktopDownloadCard는 자체 테스트(desktop-download-card.test.tsx)가 있어 여기선
// 내부를 재검증하지 않고 mock.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { redirectMock } = vi.hoisted(() => ({ redirectMock: vi.fn() }));

vi.mock('next/navigation', () => ({ redirect: redirectMock }));
vi.mock('@/components/desktop/desktop-download-card', () => ({
  DesktopDownloadCard: () => <div data-testid="desktop-download-card-stub" />,
}));

let originalEnvValue: string | undefined;

beforeEach(() => {
  originalEnvValue = process.env.DESKTOP_DOWNLOAD_ENABLED;
  redirectMock.mockClear();
});

afterEach(() => {
  if (originalEnvValue === undefined) delete process.env.DESKTOP_DOWNLOAD_ENABLED;
  else process.env.DESKTOP_DOWNLOAD_ENABLED = originalEnvValue;
  vi.resetModules();
});

describe('DesktopPage — story #4012 서버 게이트', () => {
  it('DESKTOP_DOWNLOAD_ENABLED=true → redirect 없이 카드를 렌더', async () => {
    process.env.DESKTOP_DOWNLOAD_ENABLED = 'true';
    vi.resetModules();
    const { default: DesktopPage } = await import('./page');
    const { DesktopDownloadCard } = await import('@/components/desktop/desktop-download-card');
    const result = DesktopPage() as { props: { children: { type: unknown } } };
    expect(redirectMock).not.toHaveBeenCalled();
    expect(result.props.children.type).toBe(DesktopDownloadCard);
  });

  it('DESKTOP_DOWNLOAD_ENABLED=false → /org-briefing으로 redirect(카드 렌더 없음)', async () => {
    process.env.DESKTOP_DOWNLOAD_ENABLED = 'false';
    vi.resetModules();
    const { default: DesktopPage } = await import('./page');
    DesktopPage();
    expect(redirectMock).toHaveBeenCalledWith('/org-briefing');
  });

  it('DESKTOP_DOWNLOAD_ENABLED 미설정(prod-safe 기본값) → redirect', async () => {
    delete process.env.DESKTOP_DOWNLOAD_ENABLED;
    vi.resetModules();
    const { default: DesktopPage } = await import('./page');
    DesktopPage();
    expect(redirectMock).toHaveBeenCalledWith('/org-briefing');
  });

  // story #4017 CHANGES 1(페드루 PO 지적, 2026-09-22) — 리다이렉트 목적지는 하드코딩
  // '/org-briefing'이 아니라 resolveNavV3Destinations(readNavV3FlagsFromEnv()).today.path
  // (proxy.ts와 동일 소스) — TODAY_V3_ENABLED=true면 /today로 따라간다.
  it('TODAY_V3_ENABLED=true면 목적지가 /org-briefing이 아니라 /today로(단일소스 추종)', async () => {
    process.env.DESKTOP_DOWNLOAD_ENABLED = 'false';
    process.env.TODAY_V3_ENABLED = 'true';
    vi.resetModules();
    const { default: DesktopPage } = await import('./page');
    DesktopPage();
    expect(redirectMock).toHaveBeenCalledWith('/today');
    delete process.env.TODAY_V3_ENABLED;
  });
});
