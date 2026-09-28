// @vitest-environment jsdom
//
// story #3946(규칙: 「TopBarSlot 제목은 그 화면에 다른 제목이 없을 때만 h1」) — 이 화면은
// 본문에 별도 마스트헤드가 없어(3946 AC1 실측) TopBarSlot 제목이 그대로 유일한 h1
// 후보다. session 로딩 中엔 Skeleton(비-헤딩)이 그 자리를 대신해 h1이 0개가 되던 gap을
// sr-only 자리표시자로 메웠다 — 로딩·로디드 두 상태 각각 정확히 1개임을 고정한다.
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
  id: 'session-1', project_id: 'proj-1', title: '회고 1', phase: 'closed', sprint_id: null,
  items: [], actions: [],
};

beforeEach(() => {
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
        <TestToastRenderer />
        <RetroSessionPage />
      </ToastProvider>
    )));
  });
}

describe('RetroSessionPage — 페이지 h1 1개(story #3946)', () => {
  it('⭐로딩 상태(fetch 미해결)에도 h1이 정확히 1개다(sr-only 자리표시자)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    await mount();
    const h1s = [...container.querySelectorAll('h1')];
    expect(h1s).toHaveLength(1);
    expect(h1s[0]!.className).toContain('sr-only');
  });

  it('⭐로디드 상태엔 h1이 정확히 1개다(session.title)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (typeof url === 'string' && url.includes(`/api/retro-sessions/${SESSION.id}?project_id=`)) {
        return { ok: true, json: async () => ({ data: SESSION }) };
      }
      if (typeof url === 'string' && url.includes('/api/team-members')) {
        return { ok: true, json: async () => ({ data: [] }) };
      }
      return { ok: false, json: async () => null };
    }));
    await mount();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    const h1s = [...container.querySelectorAll('h1')];
    expect(h1s).toHaveLength(1);
    expect(h1s[0]!.textContent).toBe(SESSION.title);
  });
});
