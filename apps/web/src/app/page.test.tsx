// @vitest-environment node
//
// story #4017(PO 확定 2026-09-17) AC3 — 루트 페이지의 로그인 뒤 착지가 플래그 OFF/ON
// 양쪽에서 맞는 주소로 가는지 고정.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { redirectMock, getServerSessionMock } = vi.hoisted(() => ({
  redirectMock: vi.fn(),
  getServerSessionMock: vi.fn(),
}));
vi.mock('next/navigation', () => ({ redirect: redirectMock }));
vi.mock('@/lib/db/server', () => ({ getServerSession: () => getServerSessionMock() }));

beforeEach(() => {
  redirectMock.mockClear();
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('RootPage', () => {
  it('세션 없음 — /login', async () => {
    getServerSessionMock.mockResolvedValue(null);
    const { default: RootPage } = await import('./page');
    await RootPage();
    expect(redirectMock).toHaveBeenCalledWith('/login');
  });

  it('⭐세션 있음·TODAY_V3_ENABLED 미설정(OFF) — /org-briefing(기존, 바이트 동일)', async () => {
    getServerSessionMock.mockResolvedValue({ access_token: 'tok' });
    const { default: RootPage } = await import('./page');
    await RootPage();
    expect(redirectMock).toHaveBeenCalledWith('/org-briefing');
  });

  it('⭐세션 있음·TODAY_V3_ENABLED=true — /today', async () => {
    vi.stubEnv('TODAY_V3_ENABLED', 'true');
    getServerSessionMock.mockResolvedValue({ access_token: 'tok' });
    const { default: RootPage } = await import('./page');
    await RootPage();
    expect(redirectMock).toHaveBeenCalledWith('/today');
  });
});
