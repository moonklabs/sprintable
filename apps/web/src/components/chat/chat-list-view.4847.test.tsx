// @vitest-environment jsdom
//
// story 4847 (AC1) — the chat list is the organization's rooms, not the current project's: it opens with no project picked, every room of the person is on it, each
// row says which project the room is in, and a filter narrows it to one project (or to the rooms with none) without moving the person. The old «다른 프로젝트 최근 5개» block
// stays in the code and is only drawn by the project-only fallback (an older server that still wants a project); the new list does its job instead.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ChatListView, CHAT_PROJECT_FILTER_KEY } from './chat-list-view';

vi.mock('@/hooks/use-auto-refresh', () => ({ useAutoRefresh: () => {} }));

const { useDashboardContextMock, pushMock, replaceMock, searchParamsValueRef } = vi.hoisted(() => ({
  useDashboardContextMock: vi.fn(),
  pushMock: vi.fn(),
  replaceMock: vi.fn(),
  searchParamsValueRef: { current: '' as string },
}));

vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
  useSearchParams: () => new URLSearchParams(searchParamsValueRef.current),
}));

vi.mock('@/hooks/use-chat-sse', () => ({
  useChatSse: () => ({ connected: true, polling: false }),
}));
vi.mock('@/components/realtime-provider', () => ({
  useSseMultiplexerContext: () => ({ isAlive: () => false, subscribe: () => () => {}, subscribeMessage: () => () => {}, subscribeReconnect: () => () => {}, connected: true }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const A = { projectId: 'proj-a', projectName: '프로젝트 에이' };
const B = { projectId: 'proj-b', projectName: '프로젝트 비' };

const room = (id: string, title: string, project: { id: string; name: string } | null, updated_at: string) => ({
  id, type: 'group', title, latest_message: null, updated_at, unread_count: 0,
  project_id: project?.id ?? null, project_name: project?.name ?? null,
});
const A1 = room('conv-a1', '에이 방', { id: A.projectId, name: A.projectName }, '2026-11-07T01:00:00Z');
const B1 = room('conv-b1', '비 방', { id: B.projectId, name: B.projectName }, '2026-11-07T03:00:00Z');
const N1 = room('conv-n1', '프로젝트 없는 방', null, '2026-11-07T02:00:00Z');

function wrap(node: React.ReactNode) {
  return <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  pushMock.mockClear();
  replaceMock.mockClear();
  searchParamsValueRef.current = '';
  useDashboardContextMock.mockReturnValue({ projectMemberships: [A, B], role: 'member', projectId: undefined });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  window.sessionStorage.removeItem(CHAT_PROJECT_FILTER_KEY);
});

/** an organization-wide server: no project_id → every room; project_id=<uuid|none> → that project's (or the project-less) rooms */
function stubOrgServer(all = [B1, N1, A1]) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.includes('/api/conversations/recent-outside-project')) return { ok: true, json: async () => ({ data: [] }) };
    if (url.startsWith('/api/conversations?')) {
      const filter = new URL(url, 'http://x').searchParams.get('project_id');
      const rows = filter === null ? all : filter === 'none' ? all.filter((r) => r.project_id === null) : all.filter((r) => r.project_id === filter);
      return { ok: true, json: async () => ({ data: rows, total: rows.length }) };
    }
    return { ok: false, status: 404, json: async () => null };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const listCalls = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith('/api/conversations?'));

async function mount(props: Partial<React.ComponentProps<typeof ChatListView>> = {}) {
  await act(async () => {
    root.render(wrap(<ChatListView projectId={null} currentTeamMemberId="me-1" {...props} />));
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

const rowButtons = () => [...container.querySelectorAll('button')].filter((b) => b.querySelector('[data-testid="room-project"]') || /방$/.test(b.textContent ?? ''));
const filterSelect = () => container.querySelector('[data-testid="project-filter"]') as HTMLSelectElement | null;
async function chooseFilter(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(filterSelect()!, value);
    filterSelect()!.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve(); await Promise.resolve();
  });
}

describe('ChatListView — 조직 안 모든 방 한 목록(story 4847 AC1)', () => {
  it('⭐지금 프로젝트가 없어도 열리고, project_id 없이 조직 전체를 묻는다 — 두 프로젝트의 방이 한 목록에 있다', async () => {
    const fetchMock = stubOrgServer();
    await mount({ projectId: null });
    expect(listCalls(fetchMock)).toEqual(['/api/conversations?limit=30&offset=0']);
    for (const title of ['에이 방', '비 방', '프로젝트 없는 방']) expect(container.textContent).toContain(title);
  });

  it('⭐방마다 프로젝트 이름이 붙고, 프로젝트 없는 방은 «프로젝트 없음»이다', async () => {
    stubOrgServer();
    await mount();
    const labels = [...container.querySelectorAll('[data-testid="room-project"]')].map((e) => e.textContent);
    expect(labels).toHaveLength(3);
    expect(labels).toEqual(expect.arrayContaining([A.projectName, B.projectName, koMessages.chats.roomNoProject]));
  });

  it('줄이 이름을 안 주면(project_name 없음) 내 프로젝트 목록에서 이름을 찾아 붙인다', async () => {
    stubOrgServer([{ ...B1, project_name: null }]);
    await mount();
    expect(container.querySelector('[data-testid="room-project"]')?.textContent).toBe(B.projectName);
  });

  it('⭐다른 프로젝트의 방을 눌러도 프로젝트를 바꾸는 이동이 아니다 — /chats/{id} 하나뿐(?p=전환 · from · pn 없음)', async () => {
    stubOrgServer();
    useDashboardContextMock.mockReturnValue({ projectMemberships: [A, B], role: 'member', projectId: 'proj-a' });
    await mount({ projectId: 'proj-a' });
    const bRoom = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('비 방'))!;
    await act(async () => { bRoom.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(pushMock).toHaveBeenCalledTimes(1);
    const url = String(pushMock.mock.calls[0]![0]);
    expect(url.startsWith('/chats/conv-b1')).toBe(true);
    expect(url).not.toMatch(/[?&](from|pn)=/);
    expect(url).not.toContain('p=proj-b'); // the current project stays the person's own choice
  });

  it('⭐«다른 프로젝트 최근 5개» 칸은 새 목록에서 그리지도 부르지도 않는다', async () => {
    const fetchMock = stubOrgServer();
    await mount({ projectId: 'proj-a' });
    expect(fetchMock.mock.calls.map((c) => String(c[0])).some((u) => u.includes('recent-outside-project'))).toBe(false);
    expect(container.textContent).not.toContain(koMessages.chats.otherProjectsSection);
  });
});

describe('ChatListView — 프로젝트로 걸러 보기(story 4847 AC1)', () => {
  it('⭐프로젝트가 둘 이상이면 걸러 보기가 뜨고(모든 프로젝트 · 각 프로젝트 · 프로젝트 없음), 하나뿐이면 안 뜬다', async () => {
    stubOrgServer();
    await mount();
    expect([...filterSelect()!.options].map((o) => o.textContent)).toEqual([koMessages.chats.projectFilterAll, A.projectName, B.projectName, koMessages.chats.roomNoProject]);
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    useDashboardContextMock.mockReturnValue({ projectMemberships: [A], role: 'member', projectId: undefined });
    await mount();
    expect(filterSelect()).toBeNull();
  });

  it('⭐프로젝트를 고르면 project_id=그 프로젝트로 다시 묻고 그 방들만 남는다 — 지금 프로젝트는 건드리지 않는다', async () => {
    const fetchMock = stubOrgServer();
    await mount();
    await chooseFilter(B.projectId);
    expect(listCalls(fetchMock).at(-1)).toBe('/api/conversations?limit=30&offset=0&project_id=proj-b');
    expect(container.textContent).toContain('비 방');
    expect(container.textContent).not.toContain('에이 방');
    expect(pushMock).not.toHaveBeenCalled();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('«프로젝트 없음»은 project_id=none으로 묻고, «모든 프로젝트»로 돌아오면 project_id를 빼고 묻는다', async () => {
    const fetchMock = stubOrgServer();
    await mount();
    await chooseFilter('none');
    expect(listCalls(fetchMock).at(-1)).toBe('/api/conversations?limit=30&offset=0&project_id=none');
    expect(container.textContent).toContain('프로젝트 없는 방');
    expect(container.textContent).not.toContain('에이 방');
    await chooseFilter('');
    expect(listCalls(fetchMock).at(-1)).toBe('/api/conversations?limit=30&offset=0');
  });

  it('⭐고른 값은 이 탭 안에 기억되고(sessionStorage), 다시 열면 처음부터 그 프로젝트로 묻는다(«모든 프로젝트»로 먼저 묻지 않는다)', async () => {
    const fetchMock = stubOrgServer();
    await mount();
    await chooseFilter(A.projectId);
    expect(window.sessionStorage.getItem(CHAT_PROJECT_FILTER_KEY)).toBe('proj-a');
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    fetchMock.mockClear();
    await mount();
    expect(listCalls(fetchMock)).toEqual(['/api/conversations?limit=30&offset=0&project_id=proj-a']);
    expect(filterSelect()!.value).toBe('proj-a');
  });

  it('기억된 값이 더는 내 프로젝트가 아니면 버리고 «모든 프로젝트»로 묻는다', async () => {
    window.sessionStorage.setItem(CHAT_PROJECT_FILTER_KEY, 'someone-elses-project');
    const fetchMock = stubOrgServer();
    await mount();
    expect(listCalls(fetchMock)).toEqual(['/api/conversations?limit=30&offset=0']);
    expect(filterSelect()!.value).toBe('');
  });
});

describe('ChatListView — 관리자의 에이전트 탭 · 지시 한 줄 · 새 방(story 4847)', () => {
  it('에이전트 탭은 지금 프로젝트가 있을 때만 있다(그 프로젝트의 에이전트 방을 읽는 탭이라)', async () => {
    stubOrgServer();
    useDashboardContextMock.mockReturnValue({ projectMemberships: [A, B], role: 'admin', projectId: undefined });
    await mount({ projectId: null });
    expect(container.textContent).not.toContain(koMessages.chats.agentChatsTab);
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    useDashboardContextMock.mockReturnValue({ projectMemberships: [A, B], role: 'admin', projectId: 'proj-a' });
    await mount({ projectId: 'proj-a' });
    expect(container.textContent).toContain(koMessages.chats.agentChatsTab);
  });

  it('⭐지시 한 줄(?compose=)은 목록 전체에서 가장 최근 방이 아니라 «지금 프로젝트»의 가장 최근 방으로 간다', async () => {
    searchParamsValueRef.current = 'compose=' + encodeURIComponent('지시');
    useDashboardContextMock.mockReturnValue({ projectMemberships: [A, B], role: 'member', projectId: 'proj-a' });
    stubOrgServer(); // B1 is the newest of all; A1 is the newest of proj-a
    await mount({ projectId: 'proj-a' });
    expect(replaceMock).toHaveBeenCalledTimes(1);
    expect(String(replaceMock.mock.calls[0]![0]).startsWith('/chats/conv-a1?compose=')).toBe(true);
  });

  it('⭐새 대화의 프로젝트 기본값은 걸러 보기에서 고른 프로젝트이고, 걸러 보기가 없으면 지금 프로젝트다', async () => {
    stubOrgServer();
    useDashboardContextMock.mockReturnValue({ projectMemberships: [A, B], role: 'member', projectId: 'proj-a' });
    const select = () => document.body.querySelector('#new-room-project') as HTMLSelectElement;
    const openModal = async () => {
      await act(async () => { root.render(wrap(<ChatListView projectId="proj-a" currentTeamMemberId="me-1" open onOpenChange={() => {}} />)); });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    };
    await mount({ projectId: 'proj-a', open: false, onOpenChange: () => {} });
    await openModal(); // the person pressed «새 대화» — no filter chosen
    expect(select().value).toBe('proj-a');
    await chooseFilter('proj-b'); // …and with the filter on B (the modal closes first, as it would)
    await act(async () => { root.render(wrap(<ChatListView projectId="proj-a" currentTeamMemberId="me-1" open={false} onOpenChange={() => {}} />)); });
    await openModal();
    expect(select().value).toBe('proj-b');
  });
});

describe('ChatListView — 옛 서버(조직 전체를 못 묻는 서버)의 대비 경로(story 4847)', () => {
  it('⭐조직 전체 질문이 422면 지금 프로젝트의 방으로 다시 묻고, 「다른 프로젝트」 칸이 그때만 되살아난다', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/api/conversations/recent-outside-project')) {
        return { ok: true, json: async () => ({ data: [{ id: 'conv-x', type: 'group', title: '밖의 방', project_id: 'proj-b', project_name: '프로젝트 비', project_slug: 'b' }] }) };
      }
      if (url.startsWith('/api/conversations?')) {
        if (!url.includes('project_id=')) return { ok: false, status: 422, json: async () => ({}) };
        return { ok: true, json: async () => ({ data: [{ id: 'conv-a1', type: 'group', title: '에이 방', latest_message: null, updated_at: '2026-11-07T01:00:00Z' }], total: 1 }) };
      }
      return { ok: false, status: 404, json: async () => null };
    });
    vi.stubGlobal('fetch', fetchMock);
    useDashboardContextMock.mockReturnValue({ projectMemberships: [A, B], role: 'member', projectId: 'proj-a' });
    await mount({ projectId: 'proj-a' });
    expect(listCalls(fetchMock)).toEqual([
      '/api/conversations?limit=30&offset=0',
      '/api/conversations?limit=30&offset=0&project_id=proj-a',
    ]);
    expect(container.textContent).toContain('에이 방');
    expect(container.textContent).toContain(koMessages.chats.otherProjectsSection);
    expect(container.textContent).toContain('밖의 방');
    expect(filterSelect()).toBeNull(); // the project-only list has nothing to filter
  });
});
