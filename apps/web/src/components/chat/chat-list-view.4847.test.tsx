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

const { sseOpts } = vi.hoisted(() => ({ sseOpts: { current: undefined as undefined | { onPoll?: () => Promise<boolean> } } }));
vi.mock('@/hooks/use-chat-sse', () => ({
  useChatSse: (opts: { onPoll?: () => Promise<boolean> }) => { sseOpts.current = opts; return { connected: true, polling: false }; },
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

describe('ChatListView — 질문이 바뀌는 사이의 경합(story 4847)', () => {
  it('⭐A를 묻는 중에 B로 걸러 보기를 바꾸면, 뒤늦게 온 A의 성공 응답이 B 목록을 덮지 않는다', async () => {
    window.sessionStorage.setItem(CHAT_PROJECT_FILTER_KEY, 'proj-a');
    let releaseA: (() => void) | undefined;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('recent-outside-project')) return { ok: true, json: async () => ({ data: [] }) };
      if (url.includes('project_id=proj-a')) {
        await new Promise<void>((resolve) => { releaseA = resolve; });
        return { ok: true, json: async () => ({ data: [A1], total: 1 }) };
      }
      if (url.includes('project_id=proj-b')) return { ok: true, json: async () => ({ data: [B1], total: 1 }) };
      return { ok: false, status: 404, json: async () => null };
    }));
    await mount();
    expect(releaseA).not.toBeUndefined();
    await chooseFilter('proj-b');
    expect(container.textContent).toContain('비 방');
    await act(async () => { releaseA!(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain('비 방');
    expect(container.textContent).not.toContain('에이 방');
  });
});

describe('ChatListView — 같은 것을 두 번 묻는 경합 · 현재 프로젝트 변경(story 4847, codex)', () => {
  const ALL = '/api/conversations?limit=30&offset=0';

  it('⭐현재 프로젝트가 바뀌어도 조직 전체 목록은 다시 묻지 않는다(질문에 현재 프로젝트가 없으므로)', async () => {
    const fetchMock = stubOrgServer();
    await mount({ projectId: 'proj-a' });
    const before = listCalls(fetchMock).length;
    await act(async () => { root.render(wrap(<ChatListView projectId="proj-b" currentTeamMemberId="me-1" />)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(listCalls(fetchMock)).toHaveLength(before);
    expect(container.textContent).toContain('에이 방'); // still the list it had
  });

  it('⭐«모든 프로젝트»를 묻는 중에 다른 프로젝트로 갔다가 «모든 프로젝트»로 돌아오면, 첫 물음의 뒤늦은 실패가 지금 목록을 오류로 덮지 않는다', async () => {
    let releaseFirst: (() => void) | undefined;
    let allCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('recent-outside-project')) return { ok: true, json: async () => ({ data: [] }) };
      if (url === ALL) {
        allCalls++;
        if (allCalls === 1) { await new Promise<void>((resolve) => { releaseFirst = resolve; }); return { ok: false, status: 500, json: async () => null }; }
        return { ok: true, json: async () => ({ data: [A1, B1], total: 2 }) };
      }
      if (url.includes('project_id=proj-a')) return { ok: true, json: async () => ({ data: [A1], total: 1 }) };
      return { ok: false, status: 404, json: async () => null };
    }));
    await mount();
    expect(releaseFirst).not.toBeUndefined();
    await chooseFilter('proj-a');
    await chooseFilter(''); // «모든 프로젝트» again: the same question as the first one, asked a second time
    expect(container.textContent).toContain('비 방');
    await act(async () => { releaseFirst!(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).not.toContain(koMessages.chats.conversationsLoadFailed);
    expect(container.textContent).toContain('비 방');
  });

  it('⭐옛 물음이 뒤늦게 422를 받아도 «프로젝트 단위 대비 경로»로 넘어가지 않는다(지금 걸러 보기가 그대로 산다)', async () => {
    let release422: (() => void) | undefined;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('recent-outside-project')) return { ok: true, json: async () => ({ data: [] }) };
      if (url === ALL) { await new Promise<void>((resolve) => { release422 = resolve; }); return { ok: false, status: 422, json: async () => null }; }
      if (url.includes('project_id=proj-b')) return { ok: true, json: async () => ({ data: [B1], total: 1 }) };
      return { ok: false, status: 404, json: async () => null };
    });
    vi.stubGlobal('fetch', fetchMock);
    useDashboardContextMock.mockReturnValue({ projectMemberships: [A, B], role: 'member', projectId: 'proj-a' });
    await mount({ projectId: 'proj-a' });
    await chooseFilter('proj-b');
    await act(async () => { release422!(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(filterSelect()).not.toBeNull(); // not the project-only list
    expect(container.textContent).toContain('비 방');
    expect(listCalls(fetchMock).every((u) => !u.endsWith('&project_id=proj-a'))).toBe(true); // never asked for the current project's own list
  });

  it('⭐«더 보기»를 누른 뒤 걸러 보기를 바꾸면, 뒤늦게 온 이전 목록의 다음 쪽이 새 목록에 붙지 않고 «더 보기»도 멈춰 있지 않는다', async () => {
    window.sessionStorage.setItem(CHAT_PROJECT_FILTER_KEY, 'proj-a');
    let releaseMore: (() => void) | undefined;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('recent-outside-project')) return { ok: true, json: async () => ({ data: [] }) };
      if (url.includes('project_id=proj-a') && url.includes('offset=0')) return { ok: true, json: async () => ({ data: [A1], total: 3 }) };
      if (url.includes('project_id=proj-a') && url.includes('offset=1')) {
        await new Promise<void>((resolve) => { releaseMore = resolve; });
        return { ok: true, json: async () => ({ data: [room('conv-a2', '에이 둘째 방', { id: A.projectId, name: A.projectName }, '2026-11-07T00:30:00Z')], total: 3 }) };
      }
      if (url.includes('project_id=proj-b')) return { ok: true, json: async () => ({ data: [B1], total: 1 }) };
      return { ok: false, status: 404, json: async () => null };
    }));
    await mount();
    const more = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(koMessages.common.loadMore))!;
    await act(async () => { more.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); });
    expect(releaseMore).not.toBeUndefined();
    await chooseFilter('proj-b');
    await act(async () => { releaseMore!(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain('비 방');
    expect(container.textContent).not.toContain('에이 둘째 방');
    expect(container.textContent).not.toContain('에이 방');
  });

  it('⭐첫 물음이 네트워크 오류로 뒤늦게 던져져도(응답 없이 reject) 지금 목록을 오류로 덮지 않는다', async () => {
    let rejectFirst: (() => void) | undefined;
    let allCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('recent-outside-project')) return { ok: true, json: async () => ({ data: [] }) };
      if (url === ALL) {
        allCalls++;
        if (allCalls === 1) { await new Promise<void>((resolve) => { rejectFirst = resolve; }); throw new Error('network'); }
        return { ok: true, json: async () => ({ data: [A1, B1], total: 2 }) };
      }
      if (url.includes('project_id=proj-a')) return { ok: true, json: async () => ({ data: [A1], total: 1 }) };
      return { ok: false, status: 404, json: async () => null };
    }));
    await mount();
    await chooseFilter('proj-a');
    await chooseFilter('');
    await act(async () => { rejectFirst!(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).not.toContain(koMessages.chats.conversationsLoadFailed);
    expect(container.textContent).toContain('비 방');
  });

  it('⭐본문을 읽는 사이에 새 물음이 생겨도 옛 본문이 새 목록을 덮지 않는다(응답은 왔고 json()만 늦은 경우)', async () => {
    window.sessionStorage.setItem(CHAT_PROJECT_FILTER_KEY, 'proj-a');
    let releaseBody: (() => void) | undefined;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('recent-outside-project')) return { ok: true, json: async () => ({ data: [] }) };
      if (url.includes('project_id=proj-a')) return { ok: true, json: async () => { await new Promise<void>((resolve) => { releaseBody = resolve; }); return { data: [A1], total: 1 }; } };
      if (url.includes('project_id=proj-b')) return { ok: true, json: async () => ({ data: [B1], total: 1 }) };
      return { ok: false, status: 404, json: async () => null };
    }));
    await mount();
    expect(releaseBody).not.toBeUndefined();
    await chooseFilter('proj-b');
    await act(async () => { releaseBody!(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain('비 방');
    expect(container.textContent).not.toContain('에이 방');
  });

  it('⭐옛 목록의 «더 보기»가 아직 오는 중에 걸러 보기를 바꾸면: 새 목록의 «더 보기»는 눌릴 수 있고, 새 목록의 «더 보기»를 누른 뒤 옛 쪽이 도착해도 로딩이 풀리지 않는다', async () => {
    window.sessionStorage.setItem(CHAT_PROJECT_FILTER_KEY, 'proj-a');
    let releaseMoreA: (() => void) | undefined;
    let releaseMoreB: (() => void) | undefined;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('recent-outside-project')) return { ok: true, json: async () => ({ data: [] }) };
      if (url.includes('project_id=proj-a') && url.includes('offset=0')) return { ok: true, json: async () => ({ data: [A1], total: 3 }) };
      if (url.includes('project_id=proj-a')) { await new Promise<void>((resolve) => { releaseMoreA = resolve; }); return { ok: true, json: async () => ({ data: [room('conv-a2', '에이 둘째 방', { id: A.projectId, name: A.projectName }, '2026-11-07T00:30:00Z')], total: 3 }) }; }
      if (url.includes('project_id=proj-b') && url.includes('offset=0')) return { ok: true, json: async () => ({ data: [B1], total: 3 }) };
      if (url.includes('project_id=proj-b')) { await new Promise<void>((resolve) => { releaseMoreB = resolve; }); return { ok: true, json: async () => ({ data: [room('conv-b2', '비 둘째 방', { id: B.projectId, name: B.projectName }, '2026-11-07T00:30:00Z')], total: 3 }) }; }
      return { ok: false, status: 404, json: async () => null };
    }));
    const moreButton = () => [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(koMessages.common.loadMore) || b.textContent === koMessages.common.loading && b.className.includes('text-xs')) as HTMLButtonElement | undefined;
    await mount();
    await act(async () => { moreButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); });
    expect(releaseMoreA).not.toBeUndefined();
    await chooseFilter('proj-b');
    // B's own first page is on screen and its «더 보기» is NOT stuck in the loading state of A's pending page
    expect(container.textContent).toContain('비 방');
    expect(moreButton()!.disabled).toBe(false);
    expect(moreButton()!.textContent).toContain(koMessages.common.loadMore);
    await act(async () => { moreButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); });
    expect(releaseMoreB).not.toBeUndefined();
    expect(moreButton()!.disabled).toBe(true);
    await act(async () => { releaseMoreA!(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(moreButton()!.disabled).toBe(true); // A's late page must not end B's loading
    await act(async () => { releaseMoreB!(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain('비 둘째 방');
    expect(container.textContent).not.toContain('에이 둘째 방');
  });

  it('⭐폴링 물음이 새 걸러 보기에 밀려나면 «실패»로 세지 않는다(폴링이 간격을 넓히지 않게 true) — 진짜 서버 실패는 false', async () => {
    let releasePoll: (() => void) | undefined;
    let allCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('recent-outside-project')) return { ok: true, json: async () => ({ data: [] }) };
      if (url === ALL) {
        allCalls++;
        if (allCalls === 2) { await new Promise<void>((resolve) => { releasePoll = resolve; }); return { ok: true, json: async () => ({ data: [A1, B1], total: 2 }) }; }
        if (allCalls >= 3) return { ok: false, status: 500, json: async () => null };
        return { ok: true, json: async () => ({ data: [A1, B1], total: 2 }) };
      }
      if (url.includes('project_id=proj-a')) return { ok: true, json: async () => ({ data: [A1], total: 1 }) };
      return { ok: false, status: 404, json: async () => null };
    }));
    await mount();
    let pollResult: boolean | undefined;
    await act(async () => { void sseOpts.current!.onPoll!().then((ok) => { pollResult = ok; }); await Promise.resolve(); });
    expect(releasePoll).not.toBeUndefined();
    await chooseFilter('proj-a'); // supersedes the poll's ask
    await act(async () => { releasePoll!(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(pollResult).toBe(true);
    // a real failure of the poll's own ask is still a failure
    await chooseFilter('');
    let second: boolean | undefined;
    await act(async () => { void sseOpts.current!.onPoll!().then((ok) => { second = ok; }); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(second).toBe(false);
  });

  it('프로젝트 목록을 아직 모를 때 기억된 프로젝트 값은 일단 쓰고, 목록이 와서 내 프로젝트가 아니면 «모든 프로젝트»로 돌아간다', async () => {
    const UUID = '11111111-1111-4111-8111-111111111111';
    window.sessionStorage.setItem(CHAT_PROJECT_FILTER_KEY, UUID);
    const fetchMock = stubOrgServer();
    useDashboardContextMock.mockReturnValue({ projectMemberships: [], role: 'member', projectId: undefined });
    await mount();
    expect(listCalls(fetchMock)).toEqual([`/api/conversations?limit=30&offset=0&project_id=${UUID}`]);
    useDashboardContextMock.mockReturnValue({ projectMemberships: [A, B], role: 'member', projectId: undefined }); // the shell has now told the person's projects
    await act(async () => { root.render(wrap(<ChatListView projectId={null} currentTeamMemberId="me-1" />)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(listCalls(fetchMock).at(-1)).toBe('/api/conversations?limit=30&offset=0');
    expect(window.sessionStorage.getItem(CHAT_PROJECT_FILTER_KEY)).toBeNull();
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
