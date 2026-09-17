// @vitest-environment jsdom
//
// story #4012(critical·prod 승격 준비) AC3 — `/desktop` 서버 컴포넌트 게이트 배선.
// 판정 자체(dev만 켜짐)는 desktop-download-gate.test.ts가 pin — 여기는 그 판정이
// 실제로 redirect()/카드 렌더로 이어지는지만 pin한다. DesktopDownloadCard는 자체
// 테스트(desktop-download-card.test.tsx)가 있어 여기선 내부를 재검증하지 않고 mock.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { redirectMock } = vi.hoisted(() => ({ redirectMock: vi.fn() }));

vi.mock('next/navigation', () => ({ redirect: redirectMock }));
vi.mock('@/components/desktop/desktop-download-card', () => ({
  DesktopDownloadCard: () => <div data-testid="desktop-download-card-stub" />,
}));

let originalDeployEnv: string | undefined;

beforeEach(() => {
  originalDeployEnv = process.env.DEPLOY_ENV;
  redirectMock.mockClear();
});

afterEach(() => {
  if (originalDeployEnv === undefined) delete process.env.DEPLOY_ENV;
  else process.env.DEPLOY_ENV = originalDeployEnv;
  vi.resetModules();
});

describe('DesktopPage — story #4012 서버 게이트', () => {
  it('DEPLOY_ENV=dev → redirect 없이 카드를 렌더', async () => {
    process.env.DEPLOY_ENV = 'dev';
    vi.resetModules();
    const { default: DesktopPage } = await import('./page');
    const { DesktopDownloadCard } = await import('@/components/desktop/desktop-download-card');
    const result = DesktopPage() as { props: { children: { type: unknown } } };
    expect(redirectMock).not.toHaveBeenCalled();
    expect(result.props.children.type).toBe(DesktopDownloadCard);
  });

  it('DEPLOY_ENV=prod → /org-briefing으로 redirect(카드 렌더 없음)', async () => {
    process.env.DEPLOY_ENV = 'prod';
    vi.resetModules();
    const { default: DesktopPage } = await import('./page');
    DesktopPage();
    expect(redirectMock).toHaveBeenCalledWith('/org-briefing');
  });

  it('DEPLOY_ENV 미설정(prod-safe 기본값) → redirect', async () => {
    delete process.env.DEPLOY_ENV;
    vi.resetModules();
    const { default: DesktopPage } = await import('./page');
    DesktopPage();
    expect(redirectMock).toHaveBeenCalledWith('/org-briefing');
  });
});
