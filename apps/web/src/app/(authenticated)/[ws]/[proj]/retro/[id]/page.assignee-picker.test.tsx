// @vitest-environment jsdom
//
// story #3997 CHANGES(카디르 「고르는 자리」 전수, 페드루 확定 2026-09-17) — 회고 액션
// 배정 select(RetroMemberOption)가 /api/team-members를 그대로 쓰는데 type/runtime_type
// 필드 자체가 없어 「시스템 발행」을 못 걸렀다. 필드 추가+select 후보 제외를 실 렌더로 잰다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../../messages/ko.json';

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'session-1' }),
}));
vi.mock('@/components/nav/top-bar-slot', () => ({
  TopBarSlot: ({ title, actions }: { title: React.ReactNode; actions?: React.ReactNode }) => (
    <div>{title}{actions}</div>
  ),
}));
const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(RetroRouteProvider: React.ComponentType<{ wsSlug: string; projSlug: string; projectId: string; children: React.ReactNode }>, node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      <RetroRouteProvider wsSlug="ws" projSlug="proj" projectId="proj-1">
        {node}
      </RetroRouteProvider>
    </NextIntlClientProvider>
  );
}

const SESSION = {
  id: 'session-1', project_id: 'proj-1', title: '회고 1', phase: 'action', sprint_id: null,
  items: [],
  actions: [],
};

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (typeof url === 'string' && url.includes(`/api/retro-sessions/${SESSION.id}?project_id=`)) {
      return { ok: true, json: async () => ({ data: SESSION }) };
    }
    if (typeof url === 'string' && url.includes('/api/team-members')) {
      return {
        ok: true,
        json: async () => ({
          data: [
            { id: 'm1', name: '유나', type: 'human' },
            { id: 'sp1', name: '시스템 발행', type: 'agent', runtime_type: 'system-publisher' },
            { id: 'a1', name: '점검봇', type: 'agent', runtime_type: 'claude-code' },
          ],
        }),
      };
    }
    return { ok: false, json: async () => null };
  }));
}

beforeEach(() => {
  stubFetch();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useDashboardContextMock.mockReturnValue({ orgId: 'org-1', currentTeamMemberId: 'member-1' });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function mount() {
  const { default: RetroSessionPage } = await import('./page');
  const { RetroRouteProvider } = await import('../retro-context');
  const { ToastProvider, ToastContainer, useToast } = await import('@/components/ui/toast');

  function TestToastRenderer() {
    const { toasts, dismissToast } = useToast();
    return <ToastContainer toasts={toasts} onDismiss={dismissToast} />;
  }

  await act(async () => {
    root.render(wrap(RetroRouteProvider, (
      <ToastProvider>
        <RetroSessionPage />
        <TestToastRenderer />
      </ToastProvider>
    )));
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

describe('RetroSessionPage — 액션 담당자 select 시스템 발행 제외(story #3997 CHANGES)', () => {
  it('⭐담당자 select에 「시스템 발행」이 안 뜨고 실 멤버는 그대로 뜬다', async () => {
    await mount();
    const select = [...container.querySelectorAll('select')].find((s) =>
      [...s.querySelectorAll('option')].some((o) => o.textContent === koMessages.retro.actionUnassigned),
    );
    expect(select).toBeTruthy();
    const options = [...select!.querySelectorAll('option')].map((o) => o.textContent);
    expect(options.some((t) => t?.includes('시스템 발행'))).toBe(false);
    expect(options.some((t) => t?.includes('유나'))).toBe(true);
    expect(options.some((t) => t?.includes('점검봇'))).toBe(true);
  });
});
