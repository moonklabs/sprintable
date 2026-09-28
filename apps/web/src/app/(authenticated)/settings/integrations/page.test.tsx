// @vitest-environment jsdom
// story #4231 3차 · 까디르 QA(ccef5258a [P2]) — github 파라미터 1회 소비(router.replace)는 파라미터가 이유이고 프로젝트는 싣는 값일 뿐이다.
// 프로젝트가 «모름 → A → 대기 B → A»로 바뀌는 동안에도 replace는 1번(여러 번이면 Next가 앞 이동을 버리는 경로).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../messages/ko.json';

const { ctx, replaceMock, router, params } = vi.hoisted(() => {
  const replaceMock = vi.fn();
  return {
    ctx: { projectId: undefined as string | undefined },
    replaceMock,
    router: { replace: replaceMock, push: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() },
    params: new URLSearchParams('github=connected'),
  };
});
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ctx }));
vi.mock('next/navigation', () => ({ useRouter: () => router, useSearchParams: () => params, usePathname: () => '/settings/integrations' }));
vi.mock('@/components/settings/integration-card', () => ({ IntegrationCard: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  replaceMock.mockReset();
  ctx.projectId = undefined;
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  const { setPendingProjectTarget } = await import('@/lib/pending-project-switch');
  setPendingProjectTarget(null);
});

describe('IntegrationsPage — github 파라미터 소비는 프로젝트가 정해지는 동안 1번(story #4231)', () => {
  it('⭐프로젝트 «모름 → A → 대기 B → A» — router.replace 1번, 발사 시점의 프로젝트(모름 → p 없음)', async () => {
    const { default: IntegrationsPage } = await import('./page');
    const { setPendingProjectTarget } = await import('@/lib/pending-project-switch');
    const render = async () => {
      await act(async () => {
        root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><IntegrationsPage /></NextIntlClientProvider>);
      });
    };
    await render();
    ctx.projectId = 'proj-A';
    await render();
    await act(async () => { setPendingProjectTarget('proj-B'); });
    await act(async () => { setPendingProjectTarget(null); });
    expect(replaceMock).toHaveBeenCalledTimes(1);
    expect(replaceMock).toHaveBeenCalledWith('/settings/integrations');
  });
});
