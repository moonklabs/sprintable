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

// [SID:4300] 액션 담당 칩 — 배정됐는데 배정 선택지 목록(활성만)에 없는 담당자가 «미배정»으로 보이던 거짓. 조직 범위(비활성 포함)로
// 보충해 이름으로, 담당 없음만 «미배정». 배정 선택지는 활성 목록 그대로(보충 이름이 고르는 목록에 안 섞인다).
describe('RetroSessionPage — 액션 담당 칩 이름([SID:4300])', () => {
  it('목록 밖 담당자(비활성 에이전트) → 조직 이름 · 담당 없음만 «미배정» · 선택지엔 안 섞임', async () => {
    const { resetOrgMembersCacheForTests, ORG_NAMES_URL } = await import('@/hooks/use-member-name-fallback');
    resetOrgMembersCacheForTests();
    const session = {
      ...SESSION,
      actions: [
        { id: 'act1', session_id: SESSION.id, title: '배포 점검', assignee_id: 'a-inactive', status: 'open', created_at: '2026-09-25T00:00:00Z' },
        { id: 'act2', session_id: SESSION.id, title: '문서 정리', assignee_id: null, status: 'open', created_at: '2026-09-25T00:00:00Z' },
      ],
    };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes(`/api/retro-sessions/${SESSION.id}?project_id=`)) return { ok: true, json: async () => ({ data: session }) };
      if (url === ORG_NAMES_URL) return { ok: true, json: async () => ({ data: [{ id: 'm1', name: '유나', type: 'human' }, { id: 'a-inactive', name: '쉬는봇', type: 'agent' }] }) };
      if (url === '/api/team-members') return { ok: true, json: async () => ({ data: [{ id: 'm1', name: '유나', type: 'human' }] }) };
      return { ok: false, json: async () => null };
    }));
    await mount();
    for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const rowText = (title: string) => [...container.querySelectorAll('p')].find((p) => p.textContent === title)?.parentElement?.textContent ?? '';
    expect(rowText('배포 점검')).toContain('쉬는봇');
    expect(rowText('배포 점검')).not.toContain(koMessages.retro.actionUnassigned);
    expect(rowText('문서 정리')).toContain(koMessages.retro.actionUnassigned);
    const select = [...container.querySelectorAll('select')].find((sel) =>
      [...sel.querySelectorAll('option')].some((o) => o.textContent === koMessages.retro.actionUnassigned),
    );
    expect([...select!.querySelectorAll('option')].map((o) => o.textContent)).not.toContain('쉬는봇');
  });
});

// [SID:4311 PR 2] 액션 담당 칩 줄 — 같은 이름 서로 다른 담당자 둘이면 «· ID 앞 8자»(담당자 id마다 한 번 · 같은 사람 두 칩은 같은 꼬리).
describe('RetroSessionPage — 액션 담당 칩 동명이인([SID:4311 PR 2])', () => {
  it('«송윤재» 둘 = 칩에 id 앞 8자 · 유나 = 꼬리 없음 · 담당 없음 = «미배정»', async () => {
    const { resetOrgMembersCacheForTests } = await import('@/hooks/use-member-name-fallback');
    resetOrgMembersCacheForTests();
    const action = (id: string, title: string, assignee_id: string | null) => ({ id, session_id: SESSION.id, title, assignee_id, status: 'open', created_at: '2026-09-25T00:00:00Z' });
    const session = {
      ...SESSION,
      actions: [
        action('act1', '배포 점검', 'e75ca548-1'),
        action('act2', '문서 정리', '2fd14616-2'),
        action('act3', '회고 공유', 'm1'),
        action('act4', '로그 보기', 'e75ca548-1'),
        action('act5', '표 정리', null),
      ],
    };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes(`/api/retro-sessions/${SESSION.id}?project_id=`)) return { ok: true, json: async () => ({ data: session }) };
      if (url === '/api/team-members') {
        return { ok: true, json: async () => ({ data: [{ id: 'm1', name: '유나', type: 'human' }, { id: 'e75ca548-1', name: '송윤재', type: 'human' }, { id: '2fd14616-2', name: '송윤재', type: 'human' }] }) };
      }
      return { ok: false, json: async () => null };
    }));
    await mount();
    for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const chip = (title: string) => [...container.querySelectorAll('p')].find((p) => p.textContent === title)?.nextElementSibling?.textContent ?? '';
    expect(chip('배포 점검')).toBe('송윤재 · e75ca548');
    expect(chip('문서 정리')).toBe('송윤재 · 2fd14616');
    expect(chip('회고 공유')).toBe('유나');
    expect(chip('로그 보기')).toBe('송윤재 · e75ca548');
    expect(chip('표 정리')).toBe(koMessages.retro.actionUnassigned);
  });
});
