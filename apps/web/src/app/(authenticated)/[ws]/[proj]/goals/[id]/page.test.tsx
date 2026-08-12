// @vitest-environment jsdom
//
// story #2545(카디르 라이브 재QA 5단계, PO blocking 리뷰 2026-08-12) — goals/[id]/page.tsx는
// orgSyncVersion 의존성만으론 원천적으로 못 선다:
// ①레이스에서 지는 쪽이 기본 — React가 자식 effect를 부모(DashboardShell의 switch-org)보다
//   먼저 실행하므로 이 GET의 403이 대개 switch-org보다 먼저 돌아오고, catch가 즉시
//   router.replace(목록)를 발화 → 컴포넌트 언마운트 → orgSyncVersion 재요청이 설 자리 자체가
//   사라진다.
// ②레이스에서 이겨도 진다 — stale-guard(cancelled 플래그) 없이 bump로 effect가 재실행돼 2차
//   요청이 성공해도, 뒤늦게 resolve된 1차 in-flight 403의 catch가 그대로 replace를 발화한다.
// 처방: 403(org-scope 불일치 中일 수 있음)은 replace 금지(로딩 유지·orgSyncVersion 재요청에
// 맡김) — 진짜 없음(404 등)만 목록으로. + cancelled 플래그로 재실행 시 이전 체인 무효화.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../../messages/ko.json';

// 실 Next.js useRouter()는 렌더마다 참조가 안정적이다(memoized) — 매번 새 객체를 반환하는
// 모크는 그 자체가 페이지의 fetch effect(deps에 router 포함) 재실행을 매 렌더 유발해
// «성공→setEpic→재렌더→router 참조변경→effect 재실행→재fetch→재렌더…» 무한루프를 만든다
// (실 버그 아님 — 순전히 이 모크의 인공물). vi.hoisted로 고정 참조를 만들어 방지.
const { replaceMock, routerMock } = vi.hoisted(() => {
  const replaceMock = vi.fn();
  const pushMock = vi.fn();
  return { replaceMock, routerMock: { replace: replaceMock, push: pushMock } };
});

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'epic-1' }),
  useRouter: () => routerMock,
}));

vi.mock('@/components/nav/top-bar-slot', () => ({
  TopBarSlot: ({ title, actions }: { title: React.ReactNode; actions?: React.ReactNode }) => (
    <div>{title}{actions}</div>
  ),
}));

// 이 페이지 자신의 fetch/effect/403/stale-guard 로직만 격리해서 잰다 — 자식들의 자체 fetch는
// 별도 관심사(hypotheses-section/entity-dispatch-panel 자신의 org-sync는 story #2545에서
// 각각 이미 orgSyncVersion을 얹었다).
vi.mock('@/components/dispatch/entity-dispatch-panel', () => ({
  EntityDispatchPanel: () => <div data-testid="dispatch-panel-stub" />,
}));
vi.mock('@/components/hypotheses/hypotheses-section', () => ({
  HypothesesSection: () => <div data-testid="hypotheses-section-stub" />,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(
  GoalsRouteProvider: React.ComponentType<{ wsSlug: string; projSlug: string; projectId: string; orgId: string; children: React.ReactNode }>,
  node: React.ReactNode,
) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      <GoalsRouteProvider wsSlug="ws" projSlug="proj" projectId="proj-1" orgId="org-1">
        {node}
      </GoalsRouteProvider>
    </NextIntlClientProvider>
  );
}

function epicFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'epic-1', title: '목표 제목', description: '', status: 'active', priority: 'medium',
    project_id: 'proj-1', assignee_id: null, target_story_points: null, target_date: null,
    stories: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    ...overrides,
  };
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
  vi.resetModules();
  replaceMock.mockReset();
});

async function mount(fetchImpl: (...args: unknown[]) => Promise<unknown>) {
  vi.stubGlobal('fetch', fetchImpl);
  const { default: EpicDetailPage } = await import('./page');
  const { GoalsRouteProvider } = await import('../goals-context');
  await act(async () => { root.render(wrap(GoalsRouteProvider, <EpicDetailPage />)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  return { EpicDetailPage, GoalsRouteProvider };
}

describe('EpicDetailPage — 403 vs 404 분리 (story #2545)', () => {
  it('403이면 replace를 호출하지 않고 로딩 상태를 유지한다', async () => {
    await mount(vi.fn(async () => ({ ok: false, status: 403, json: async () => null })));
    expect(replaceMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain(koMessages.goals.loading);
  });

  it('404(진짜 없음)면 목록으로 replace한다', async () => {
    await mount(vi.fn(async () => ({ ok: false, status: 404, json: async () => null })));
    expect(replaceMock).toHaveBeenCalledWith('/ws/proj/goals');
  });

  it('성공하면 목표 화면이 렌더되고 replace는 0회다', async () => {
    await mount(vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: epicFixture() }) })));
    expect(replaceMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain('목표 제목');
  });
});

describe('EpicDetailPage — org-sync stale-guard (story #2545)', () => {
  it('1차 403(in-flight) 中 bump로 2차 요청이 시작되고, 뒤늦게 resolve된 1차 403은 무시된다(replace 0회·화면 복구)', async () => {
    let calls = 0;
    let resolveFirst!: (v: { ok: boolean; status: number; json: () => Promise<unknown> }) => void;
    const firstPending = new Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>((resolve) => {
      resolveFirst = resolve;
    });

    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return firstPending; // 1차 — 의도적으로 오래 걸림(in-flight)
      return { ok: true, status: 200, json: async () => ({ data: epicFixture({ title: '회복된 목표' }) }) }; // 2차
    });

    const { EpicDetailPage, GoalsRouteProvider } = await (async () => {
      vi.stubGlobal('fetch', fetchImpl);
      const pageMod = await import('./page');
      const ctxMod = await import('../goals-context');
      return { EpicDetailPage: pageMod.default, GoalsRouteProvider: ctxMod.GoalsRouteProvider };
    })();

    await act(async () => {
      root.render(wrap(GoalsRouteProvider, <EpicDetailPage />));
      await Promise.resolve();
    });
    expect(calls).toBe(1); // 1차 요청 in-flight, 아직 미해결

    // org-sync 성공 直後 bump — 2차 요청 시작(1차는 여전히 pending).
    const { bumpOrgSyncVersion } = await import('@/lib/project-context-client');
    await act(async () => {
      bumpOrgSyncVersion();
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });
    expect(calls).toBe(2); // 2차 요청 발화됨(성공 mock 즉시 resolve)
    expect(container.textContent).toContain('회복된 목표'); // 2차 성공이 이미 화면에 반영

    // 이제 뒤늦게 1차(옛 org 403)가 resolve — stale-guard가 없으면 여기서 replace가 뒤늦게 발화된다.
    await act(async () => {
      resolveFirst({ ok: false, status: 403, json: async () => null });
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });

    expect(replaceMock).not.toHaveBeenCalled(); // stale 1차가 뒤늦게 replace를 발화하지 않는다
    expect(container.textContent).toContain('회복된 목표'); // 2차 성공 화면 그대로 유지
  });
});
