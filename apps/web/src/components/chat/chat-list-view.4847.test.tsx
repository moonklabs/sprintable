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
import { ChatRailProvider, useChatRail } from '@/app/(authenticated)/chats/chat-rail-context';

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
// the agents tab belongs to the organization's owner/admin (the organization role, orgMemberships — not the shell's «role»)
const ORG_ADMIN = { orgId: 'org-4847-admin', orgMemberships: [{ orgId: 'org-4847-admin', orgName: 'O', orgSlug: 'o', role: 'admin' }] };
const orgAs = (role: string) => ({ orgId: 'org-4847-admin', orgMemberships: [{ orgId: 'org-4847-admin', orgName: 'O', orgSlug: 'o', role }] });
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

  it('⭐폴링 물음의 응답은 왔는데 본문을 읽는 사이에 밀려나도 «실패»가 아니다(true)', async () => {
    let releaseBody: (() => void) | undefined;
    let allCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('recent-outside-project')) return { ok: true, json: async () => ({ data: [] }) };
      if (url === ALL) {
        allCalls++;
        if (allCalls === 2) return { ok: true, json: async () => { await new Promise<void>((resolve) => { releaseBody = resolve; }); return { data: [A1, B1], total: 2 }; } };
        return { ok: true, json: async () => ({ data: [A1, B1], total: 2 }) };
      }
      if (url.includes('project_id=proj-a')) return { ok: true, json: async () => ({ data: [A1], total: 1 }) };
      return { ok: false, status: 404, json: async () => null };
    }));
    await mount();
    let pollResult: boolean | undefined;
    await act(async () => { void sseOpts.current!.onPoll!().then((ok) => { pollResult = ok; }); await Promise.resolve(); await Promise.resolve(); });
    expect(releaseBody).not.toBeUndefined();
    await chooseFilter('proj-a');
    await act(async () => { releaseBody!(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(pollResult).toBe(true);
  });

  it('프로젝트 목록을 아직 모를 때 기억된 프로젝트 값은 일단 쓰고, 목록이 와서 내 프로젝트가 아니면 «모든 프로젝트»로 돌아간다', async () => {
    const UUID = '11111111-1111-4111-8111-111111111111';
    window.sessionStorage.setItem(CHAT_PROJECT_FILTER_KEY, UUID);
    const fetchMock = stubOrgServer();
    useDashboardContextMock.mockReturnValue({ projectMemberships: [], role: 'member', projectId: undefined, orgSyncPending: true }); // the shell says the list is not reliable yet
    await mount();
    expect(listCalls(fetchMock)).toEqual([`/api/conversations?limit=30&offset=0&project_id=${UUID}`]);
    useDashboardContextMock.mockReturnValue({ projectMemberships: [A, B], role: 'member', projectId: undefined }); // the shell has now told the person's projects
    await act(async () => { root.render(wrap(<ChatListView projectId={null} currentTeamMemberId="me-1" />)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(listCalls(fetchMock).at(-1)).toBe('/api/conversations?limit=30&offset=0');
    expect(window.sessionStorage.getItem(CHAT_PROJECT_FILTER_KEY)).toBeNull();
  });
});

describe('ChatListView — 프로젝트가 하나도 없다고 확실한 사람의 낡은 걸러 보기 값(story 4847, codex)', () => {
  const UUID = '22222222-2222-4222-8222-222222222222';

  it('⭐프로젝트가 없다고 확실한데 탭에 옛 프로젝트 값이 남아 있으면 그 값으로 묻지 않는다 — «모든 방»으로 묻고 «새 대화»를 열 수 있다는 표지가 선다', async () => {
    window.sessionStorage.setItem(CHAT_PROJECT_FILTER_KEY, UUID);
    const fetchMock = stubOrgServer([N1]);
    useDashboardContextMock.mockReturnValue({ projectMemberships: [], role: 'member', projectId: undefined });
    await act(async () => { root.render(wrap(<ChatRailProvider><OrgWideReport /><ChatListView projectId={null} currentTeamMemberId="me-1" /></ChatRailProvider>)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(listCalls(fetchMock)).toEqual(['/api/conversations?limit=30&offset=0']);
    expect(container.querySelector('[data-testid="org-wide-report"]')?.textContent).toBe('true');
  });

  it('⭐프로젝트가 있던 사람이 프로젝트 없는 조직으로 옮겨(멤버십이 비면) 남은 걸러 보기 값은 «모든 프로젝트»로 돌아가 저장도 지워진다', async () => {
    window.sessionStorage.setItem(CHAT_PROJECT_FILTER_KEY, A.projectId);
    const fetchMock = stubOrgServer([A1, B1]);
    useDashboardContextMock.mockReturnValue({ projectMemberships: [A, B], role: 'member', projectId: undefined });
    await mount();
    expect(listCalls(fetchMock).at(-1)).toBe(`/api/conversations?limit=30&offset=0&project_id=${A.projectId}`);
    useDashboardContextMock.mockReturnValue({ projectMemberships: [], role: 'member', projectId: undefined });
    await act(async () => { root.render(wrap(<ChatListView projectId={null} currentTeamMemberId="me-1" />)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(listCalls(fetchMock).at(-1)).toBe('/api/conversations?limit=30&offset=0');
    expect(window.sessionStorage.getItem(CHAT_PROJECT_FILTER_KEY)).toBeNull();
  });
});

describe('ChatListView — 관리자의 에이전트 탭 · 지시 한 줄 · 새 방(story 4847)', () => {
  it('에이전트 탭은 지금 프로젝트가 있을 때만 있다(그 프로젝트의 에이전트 방을 읽는 탭이라)', async () => {
    stubOrgServer();
    useDashboardContextMock.mockReturnValue({ projectMemberships: [A, B], role: 'admin', ...ORG_ADMIN, projectId: undefined });
    await mount({ projectId: null });
    expect(container.textContent).not.toContain(koMessages.chats.agentChatsTab);
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    useDashboardContextMock.mockReturnValue({ projectMemberships: [A, B], role: 'admin', ...ORG_ADMIN, projectId: 'proj-a' });
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

// PO's merge condition (4847): on an older server (the organization-wide read answers 422) the screen is what it was before this story — same rooms, same sections, same «다른 프로젝트» block and
// its navigation, same agent tab, same «더 보기», same instruction-line route, and with no current project the same one «pick a project» line.
describe('ChatListView — 옛 서버(422)에서는 지금 화면과 같다 (story 4847 병합 조건)', () => {
  const OLD_ROWS = [
    { id: 'conv-dm', type: 'dm', title: null, latest_message: { content: '안녕', created_at: '2026-11-07T02:00:00Z' }, updated_at: '2026-11-07T02:00:00Z', unread_count: 1, participants: [{ member_id: 'me-1', name: '나', type: 'human' }, { member_id: 'a-bot', name: '점검봇', type: 'agent' }] },
    { id: 'conv-group', type: 'group', title: '회의방', latest_message: null, updated_at: '2026-11-07T01:00:00Z', unread_count: 0, participants: [] },
  ];
  const OUTSIDE = { id: 'conv-x', type: 'group', title: '밖의 방', project_id: 'proj-b', project_name: '프로젝트 비', project_slug: 'b' };
  function oldServer() {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/recent-outside-project')) return { ok: true, json: async () => ({ data: [OUTSIDE] }) };
      if (url.startsWith('/api/conversations?')) {
        const q = new URL(url, 'http://x').searchParams;
        if (!q.has('project_id')) return { ok: false, status: 422, json: async () => ({ detail: 'project_id required' }) };
        if (q.get('include_agent_conversations') === 'true') return { ok: true, json: async () => ({ data: [...OLD_ROWS, { id: 'conv-agent', type: 'group', title: '에이전트끼리', latest_message: null, updated_at: '2026-11-07T00:00:00Z', participants: [] }], total: 3 }) };
        return { ok: true, json: async () => ({ data: OLD_ROWS, total: 2 }) };
      }
      return { ok: false, status: 404, json: async () => null };
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }
  const ctx = (extra: Record<string, unknown> = {}) => useDashboardContextMock.mockReturnValue({ projectMemberships: [A, B], role: 'member', projectId: 'proj-a', ...extra });

  it('⭐같은 방 · 같은 구역 · 프로젝트 표시와 걸러 보기는 없다(옛 목록에는 없던 것) · 같은 «현재 프로젝트» 질문', async () => {
    const fetchMock = oldServer(); ctx();
    await mount({ projectId: 'proj-a' });
    const params = (u: string) => Object.fromEntries(new URL(u, 'http://x').searchParams);
    expect(listCalls(fetchMock).map(params)).toEqual([{ limit: '30', offset: '0' }, { limit: '30', offset: '0', project_id: 'proj-a' }]);
    expect(container.textContent).toContain(koMessages.chats.dmSection);
    expect(container.textContent).toContain(koMessages.chats.groupSection);
    expect(container.textContent).toContain('점검봇');
    expect(container.textContent).toContain('회의방');
    expect(container.querySelectorAll('[data-testid="room-project"]')).toHaveLength(0);
    expect(filterSelect()).toBeNull();
  });

  it('⭐«다른 프로젝트» 칸이 그대로 있고, 누르면 예전처럼 대상 프로젝트(p) · 원 프로젝트(from) · 이름(pn)을 실어 이동한다', async () => {
    oldServer(); ctx();
    await mount({ projectId: 'proj-a' });
    expect(container.textContent).toContain(koMessages.chats.otherProjectsSection);
    const row = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('밖의 방'))!;
    await act(async () => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const url = String(pushMock.mock.calls.at(-1)![0]);
    expect(url).toContain('/chats/conv-x?');
    expect(new URL(url, 'http://x').searchParams.get('p')).toBe('proj-b');
    expect(new URL(url, 'http://x').searchParams.get('from')).toBe('proj-a');
    expect(new URL(url, 'http://x').searchParams.get('pn')).toBe('프로젝트 비');
  });

  it('관리자의 에이전트 탭도 그대로: 같은 주소(project_id · include_agent_conversations)로 읽는다', async () => {
    const fetchMock = oldServer(); ctx({ role: 'admin', ...ORG_ADMIN });
    await mount({ projectId: 'proj-a' });
    const tab = [...container.querySelectorAll('[role="tab"]')].find((t) => t.textContent === koMessages.chats.agentChatsTab)!;
    await act(async () => { tab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); tab.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); await Promise.resolve(); });
    expect(listCalls(fetchMock).at(-1)).toBe('/api/conversations?project_id=proj-a&include_agent_conversations=true&limit=30&offset=0');
  });

  it('지시 한 줄은 그 목록의 가장 최근 방으로, 현재 프로젝트를 싣고 간다', async () => {
    searchParamsValueRef.current = 'compose=' + encodeURIComponent('지시');
    oldServer(); ctx();
    await mount({ projectId: 'proj-a' });
    expect(replaceMock).toHaveBeenCalledWith('/chats/conv-dm?compose=' + encodeURIComponent('지시') + '&p=proj-a');
  });

  it('⭐현재 프로젝트가 없으면 예전처럼 «프로젝트를 고르세요» 한 줄 — 오류도 목록도 아니다. 프로젝트를 고르면 그 프로젝트의 목록이 선다', async () => {
    const fetchMock = oldServer(); ctx({ projectId: undefined });
    await mount({ projectId: null });
    expect(container.querySelector('[data-testid="chats-no-project"]')?.textContent).toBe(koMessages.chats.pickProject);
    expect(container.textContent).not.toContain(koMessages.chats.conversationsLoadFailed);
    expect(container.textContent).not.toContain('회의방');
    ctx();
    await act(async () => { root.render(wrap(<ChatListView projectId="proj-a" currentTeamMemberId="me-1" />)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(container.querySelector('[data-testid="chats-no-project"]')).toBeNull();
    expect(container.textContent).toContain('회의방');
    expect(listCalls(fetchMock).at(-1)).toBe('/api/conversations?limit=30&offset=0&project_id=proj-a');
  });

  it('⭐옛 서버의 프로젝트 단위 목록을 보다가 현재 프로젝트를 잃으면 오류가 아니라 «프로젝트를 고르세요» 한 줄이다', async () => {
    oldServer(); ctx();
    await mount({ projectId: 'proj-a' });
    expect(container.textContent).toContain('회의방');
    ctx({ projectId: undefined });
    await act(async () => { root.render(wrap(<ChatListView projectId={null} currentTeamMemberId="me-1" />)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(container.querySelector('[data-testid="chats-no-project"]')?.textContent).toBe(koMessages.chats.pickProject);
    expect(container.textContent).not.toContain(koMessages.chats.conversationsLoadFailed);
  });

  it('⭐현재 프로젝트가 없는 동안엔 지시 한 줄(?compose=)이 소비되지 않는다 — 새 대화 모달도 안 열리고, 프로젝트가 생기면 그 목록의 가장 최근 방으로 간다', async () => {
    searchParamsValueRef.current = 'compose=' + encodeURIComponent('지시');
    oldServer(); ctx({ projectId: undefined });
    const onOpenChange = vi.fn();
    await mount({ projectId: null, open: false, onOpenChange });
    expect(container.querySelector('[data-testid="chats-no-project"]')).not.toBeNull();
    expect(onOpenChange).not.toHaveBeenCalledWith(true);
    expect(replaceMock).not.toHaveBeenCalled();
    ctx();
    await act(async () => { root.render(wrap(<ChatListView projectId="proj-a" currentTeamMemberId="me-1" open={false} onOpenChange={onOpenChange} />)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(replaceMock).toHaveBeenCalledWith('/chats/conv-dm?compose=' + encodeURIComponent('지시') + '&p=proj-a');
  });
});

// PO (4847 follow-up): with 4846 PR1 a room outlives its project, so a person with NO project can still have rooms. The layout no longer stops them; the list says «no project yet» only
// when there is no project AND no room read.
describe('ChatListView — 프로젝트가 하나도 없는 사람(story 4847, PO 후속)', () => {
  const noProjects = () => useDashboardContextMock.mockReturnValue({ projectMemberships: [], role: 'member', projectId: undefined });

  it('⭐프로젝트 0 · 방 2 → 방 목록이 선다(멈춤 한 줄 없음)', async () => {
    noProjects(); stubOrgServer([B1, N1]);
    await mount();
    expect(container.textContent).toContain('비 방');
    expect(container.textContent).toContain('프로젝트 없는 방');
    expect(container.querySelector('[data-testid="chats-no-project"]')).toBeNull();
  });

  it('⭐프로젝트 0 · 방 0 · 조직 전체를 읽는 서버 → «대화가 없어요»(프로젝트 없이 방을 만들 수 있으니 시작할 곳이 있다) — 한 줄 멈춤이 아니다', async () => {
    noProjects(); stubOrgServer([]);
    await mount();
    expect(container.querySelector('[data-testid="chats-no-project"]')).toBeNull();
    expect(container.textContent).toContain(koMessages.chats.noConversations);
  });

  it('프로젝트가 있고 방이 0이면 한 줄이 아니라 «대화가 없어요»다', async () => {
    useDashboardContextMock.mockReturnValue({ projectMemberships: [A], role: 'member', projectId: undefined });
    stubOrgServer([]);
    await mount();
    expect(container.querySelector('[data-testid="chats-no-project"]')).toBeNull();
    expect(container.textContent).toContain(koMessages.chats.noConversations);
  });

  it('⭐읽는 중에는 한 줄이 번쩍하지 않고(로딩), 읽기에 실패하면 한 줄 대신 실패 문구다', async () => {
    noProjects();
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    await mount();
    expect(container.querySelector('[data-testid="chats-no-project"]')).toBeNull();
    expect(container.textContent).toContain(koMessages.common.loading);
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => null })));
    await mount();
    expect(container.querySelector('[data-testid="chats-no-project"]')).toBeNull();
    expect(container.textContent).toContain(koMessages.chats.conversationsLoadFailed);
  });

  it('⭐옛 서버(422) · 프로젝트 0 → 지금 화면 그대로 «보여 줄 프로젝트가 아직 없어요»(고르세요가 아니다)', async () => {
    noProjects();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('recent-outside-project')) return { ok: true, json: async () => ({ data: [] }) };
      return { ok: false, status: 422, json: async () => ({}) };
    }));
    await mount();
    expect(container.querySelector('[data-testid="chats-no-project"]')?.textContent).toBe(koMessages.chats.noProjectYet);
  });

  it('⭐경로의 프로젝트를 아직 푸는 중이면(멤버십이 아직 빈 순간) «프로젝트 없음» 한 줄이 번쩍하지 않는다', async () => {
    useDashboardContextMock.mockReturnValue({ projectMemberships: [], role: 'member', projectId: undefined, projectPathUnresolved: true });
    stubOrgServer([]);
    await mount();
    expect(container.querySelector('[data-testid="chats-no-project"]')).toBeNull();
    expect(container.textContent).toContain(koMessages.chats.noConversations);
  });

  it('⭐옛 서버(422) · 프로젝트 0 · 방 0이면 지시 한 줄(?compose=)이 만들 수 없는 새 대화 창을 열지 않는다', async () => {
    searchParamsValueRef.current = 'compose=' + encodeURIComponent('지시');
    noProjects();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('recent-outside-project')) return { ok: true, json: async () => ({ data: [] }) };
      return { ok: false, status: 422, json: async () => ({}) };
    }));
    const onOpenChange = vi.fn();
    await mount({ open: false, onOpenChange });
    expect(onOpenChange).not.toHaveBeenCalledWith(true);
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('⭐프로젝트 0 · 방 0이어도 서버가 조직 전체를 읽어 주면 지시 한 줄(?compose=)이 새 대화 창을 연다(프로젝트 없는 방을 만들 수 있다)', async () => {
    searchParamsValueRef.current = 'compose=' + encodeURIComponent('지시');
    noProjects(); stubOrgServer([]);
    const onOpenChange = vi.fn();
    await mount({ open: false, onOpenChange });
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('⭐프로젝트 0 · 읽기 실패(서버가 조직 전체를 읽어 주는지 모름)면 지시 한 줄(?compose=)이 만들 수 있는지 모르는 새 대화 창을 열지 않는다', async () => {
    searchParamsValueRef.current = 'compose=' + encodeURIComponent('지시');
    noProjects();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => null })));
    const onOpenChange = vi.fn();
    await mount({ open: false, onOpenChange });
    expect(container.textContent).toContain(koMessages.chats.conversationsLoadFailed);
    expect(onOpenChange).not.toHaveBeenCalledWith(true);
  });

  it('⭐프로젝트 0이고 읽기가 한 번 실패한 뒤 다시 읽어 서버가 허락한다고 알면 지시 한 줄(?compose=)이 그제야 새 대화 창을 연다(실패 때 소비되지 않는다)', async () => {
    searchParamsValueRef.current = 'compose=' + encodeURIComponent('지시');
    noProjects();
    let failing = true;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('recent-outside-project')) return { ok: true, json: async () => ({ data: [] }) };
      return failing ? { ok: false, status: 500, json: async () => null } : { ok: true, json: async () => ({ data: [], total: 0 }) };
    }));
    const onOpenChange = vi.fn();
    await mount({ open: false, onOpenChange });
    expect(onOpenChange).not.toHaveBeenCalledWith(true);
    failing = false;
    await act(async () => { await sseOpts.current!.onPoll!(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it('프로젝트 0 · 방 있음이면 지시 한 줄은 그 목록의 가장 최근 방으로 간다', async () => {
    searchParamsValueRef.current = 'compose=' + encodeURIComponent('지시');
    noProjects(); stubOrgServer([B1, N1]);
    await mount();
    expect(String(replaceMock.mock.calls[0]![0]).startsWith('/chats/conv-b1?compose=')).toBe(true);
  });
});

// story 4847 — the server that answers the whole-organization read also lets a room be made with no project: the list says so (up to the layout and the outlet) and the new-room window offers
// «조직 (프로젝트 없음)». An older server (422) gets neither. A project's OWN list proves nothing — an older server answers that too.
function OrgWideReport() {
  const { roomsAreOrgWide } = useChatRail();
  return <div data-testid="org-wide-report">{String(roomsAreOrgWide)}</div>;
}
/** what the right-hand outlet would be told about the visible list's load (a refused agents view must not read there as «불러오지 못했어요») */
function LoadErrorReport() {
  const { conversationsLoadError } = useChatRail();
  return <div data-testid="load-error-report">{String(conversationsLoadError)}</div>;
}

describe('ChatListView — 프로젝트 없는 방을 만들 수 있는 서버(story 4847)', () => {
  const orgWideReported = () => container.querySelector('[data-testid="org-wide-report"]')?.textContent;
  const newRoomSelect = () => document.body.querySelector('#new-room-project') as HTMLSelectElement | null;
  const noneChoice = () => newRoomSelect()?.querySelector('option[value="none"]');

  beforeEach(() => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
  });

  async function mountWithRail(props: Partial<React.ComponentProps<typeof ChatListView>> = {}) {
    await act(async () => {
      root.render(wrap(
        <ChatRailProvider>
          <OrgWideReport />
          <ChatListView projectId={null} currentTeamMemberId="me-1" {...props} />
        </ChatRailProvider>,
      ));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  }

  it('⭐조직 전체 질문에 답이 오면 «프로젝트 없는 방을 만들 수 있음»을 위(레일 context)로 알린다 — 응답 前엔 아니다', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    await mountWithRail();
    expect(orgWideReported()).toBe('false');
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    stubOrgServer();
    await mountWithRail();
    expect(orgWideReported()).toBe('true');
  });

  it('⭐목록이 다시 마운트돼도(레일 context는 그대로) 이미 알려진 «프로젝트 없는 방을 만들 수 있음»은 새 응답이 오기 前에 꺼지지 않는다', async () => {
    stubOrgServer();
    await mountWithRail();
    expect(orgWideReported()).toBe('true');
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {}))); // the next read never answers
    await act(async () => {
      root.render(wrap(
        <ChatRailProvider>
          <OrgWideReport />
          <div key="other"><ChatListView projectId={null} currentTeamMemberId="me-1" /></div>
        </ChatRailProvider>,
      ));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(orgWideReported()).toBe('true'); // the flag belongs to the rail, not to the list that happened to report it
  });

  it('⭐옛 서버(조직 전체 질문이 422)는 알리지 않는다 — 프로젝트 단위로 물러난 뒤에도', async () => {
    useDashboardContextMock.mockReturnValue({ projectMemberships: [A], role: 'member', projectId: A.projectId });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('recent-outside-project')) return { ok: true, json: async () => ({ data: [] }) };
      if (url.includes('project_id=')) return { ok: true, json: async () => ({ data: [A1], total: 1 }) };
      return { ok: false, status: 422, json: async () => ({}) };
    }));
    await mountWithRail({ projectId: A.projectId });
    expect(container.textContent).toContain('에이 방'); // the project's own list was answered…
    expect(orgWideReported()).toBe('false');          // …which an older server does as well: it proves nothing
  });

  it('⭐조직 전체를 읽는 서버면 새 대화 창에 «조직 (프로젝트 없음)»이 있고, 옛 서버면 없다', async () => {
    useDashboardContextMock.mockReturnValue({ projectMemberships: [A, B], role: 'member', projectId: A.projectId });
    stubOrgServer();
    await mountWithRail({ projectId: A.projectId, open: true, onOpenChange: () => {} });
    expect(noneChoice()?.textContent).toBe(koMessages.chats.newRoomProjectNone);
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('recent-outside-project')) return { ok: true, json: async () => ({ data: [] }) };
      if (url.includes('project_id=')) return { ok: true, json: async () => ({ data: [A1], total: 1 }) };
      return { ok: false, status: 422, json: async () => ({}) };
    }));
    await mountWithRail({ projectId: A.projectId, open: true, onOpenChange: () => {} });
    expect(newRoomSelect()).not.toBeNull(); // two projects: the project choice is still there
    expect(noneChoice()).toBeNull();
  });

  it('⭐걸러 보기를 «프로젝트 없음»으로 두고 새 대화를 열면 새 방의 기본값이 «조직 (프로젝트 없음)»이다', async () => {
    stubOrgServer();
    window.sessionStorage.setItem(CHAT_PROJECT_FILTER_KEY, 'none');
    await mountWithRail({ open: true, onOpenChange: () => {} });
    expect(newRoomSelect()?.value).toBe('none');
  });

  it('⭐프로젝트 하나뿐인 사람이 «프로젝트 A»만 걸러 보면 «조직 전체»를 묻지 않았으니 알리지 않는다(그 질문은 옛 서버도 답한다)', async () => {
    useDashboardContextMock.mockReturnValue({ projectMemberships: [A, B], role: 'member', projectId: undefined });
    window.sessionStorage.setItem(CHAT_PROJECT_FILTER_KEY, A.projectId);
    stubOrgServer();
    await mountWithRail();
    expect(orgWideReported()).toBe('false');
  });
});

// story 4847 — the agents view (`include_agent_conversations`) is the organization owner/admin's: the server refuses everyone else with 403. The tab stands on the ORGANIZATION role
// (orgMemberships), not on the shell's «role» (/me: the larger of the project and organization roles — a project admin who is only an organization member has `admin` there and used
// to see a tab the server then refused), and a 403 is said as what it is, not as a failure to retry.
describe('ChatListView — 에이전트 탭은 조직 owner/admin 몫(story 4847 · 서버와 같은 술어)', () => {
  const tabs = () => [...container.querySelectorAll('[role="tab"]')].map((t) => t.textContent);
  const withCtx = (extra: Record<string, unknown>) => useDashboardContextMock.mockReturnValue({ projectMemberships: [A, B], projectId: 'proj-a', ...extra });
  const openAgentTab = async () => {
    const tab = [...container.querySelectorAll('[role="tab"]')].find((t) => t.textContent === koMessages.chats.agentChatsTab)!;
    await act(async () => { tab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); tab.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  };

  it('⭐프로젝트 관리자(셸 role=admin)가 조직에서는 member면 탭이 없다 — 서버가 403으로 거절할 보기를 보여 주지 않는다', async () => {
    stubOrgServer(); withCtx({ role: 'admin', ...orgAs('member') });
    await mount({ projectId: 'proj-a' });
    expect(tabs()).not.toContain(koMessages.chats.agentChatsTab);
  });

  it('⭐조직 owner · 조직 admin이면 셸 role이 무엇이든 탭이 있다', async () => {
    for (const orgRole of ['owner', 'admin']) {
      stubOrgServer(); withCtx({ role: 'member', ...orgAs(orgRole) });
      await mount({ projectId: 'proj-a' });
      expect(tabs()).toContain(koMessages.chats.agentChatsTab);
      await act(async () => { root.unmount(); });
      root = createRoot(container);
    }
  });

  it('현재 조직이 조직 목록에 아직 없으면(아직 모름) 탭을 세우지 않는다', async () => {
    stubOrgServer(); withCtx({ role: 'owner', orgId: 'org-9', orgMemberships: [{ orgId: 'org-4847-admin', orgName: 'O', orgSlug: 'o', role: 'owner' }] });
    await mount({ projectId: 'proj-a' });
    expect(tabs()).not.toContain(koMessages.chats.agentChatsTab);
  });

  it('⭐서버가 403으로 거절하면 «이 보기는 조직 관리자만»이다 — «불러오지 못했어요»도 «다시 시도»도 아니다(탭 안 · 내 대화 탭은 그대로)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('recent-outside-project')) return { ok: true, json: async () => ({ data: [] }) };
      if (url.includes('include_agent_conversations=true')) return { ok: false, status: 403, json: async () => ({}) };
      if (url.startsWith('/api/conversations?')) return { ok: true, json: async () => ({ data: [A1], total: 1 }) };
      return { ok: false, status: 404, json: async () => null };
    });
    vi.stubGlobal('fetch', fetchMock);
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    withCtx({ role: 'admin', ...ORG_ADMIN });
    await act(async () => {
      root.render(wrap(
        <ChatRailProvider>
          <LoadErrorReport />
          <ChatListView projectId="proj-a" currentTeamMemberId="me-1" />
        </ChatRailProvider>,
      ));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    await openAgentTab();
    expect(container.querySelector('[data-testid="load-error-report"]')?.textContent).toBe('false'); // the outlet is not told «failed» either
    const note = container.querySelector('[data-testid="agent-chats-admin-only"]');
    expect(note?.textContent).toBe(koMessages.chats.agentChatsAdminOnly);
    expect(container.textContent).not.toContain(koMessages.chats.conversationsLoadFailed);
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === koMessages.common.retry)).toBe(false);
  });

  it('⭐거절은 영원하지 않다 — 다음에 다시 물어(폴링) 이번엔 열려 주면 «조직 관리자만» 안내는 걷힌다', async () => {
    let agentStatus = 403;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('recent-outside-project')) return { ok: true, json: async () => ({ data: [] }) };
      if (url.includes('include_agent_conversations=true')) {
        return agentStatus === 403 ? { ok: false, status: 403, json: async () => ({}) } : { ok: true, json: async () => ({ data: [], total: 0 }) };
      }
      if (url.startsWith('/api/conversations?')) return { ok: true, json: async () => ({ data: [A1], total: 1 }) };
      return { ok: false, status: 404, json: async () => null };
    }));
    withCtx({ role: 'admin', ...ORG_ADMIN });
    await mount({ projectId: 'proj-a' });
    await openAgentTab();
    expect(container.querySelector('[data-testid="agent-chats-admin-only"]')).not.toBeNull();
    agentStatus = 200;
    await act(async () => { await sseOpts.current!.onPoll!(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(container.querySelector('[data-testid="agent-chats-admin-only"]')).toBeNull();
    expect(container.textContent).toContain(koMessages.chats.noAgentConversations);
  });

  it('⭐다른 실패(500)는 그대로 «불러오지 못했어요 · 다시 시도»다 — 403만 따로 말한다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('recent-outside-project')) return { ok: true, json: async () => ({ data: [] }) };
      if (url.includes('include_agent_conversations=true')) return { ok: false, status: 500, json: async () => ({}) };
      if (url.startsWith('/api/conversations?')) return { ok: true, json: async () => ({ data: [A1], total: 1 }) };
      return { ok: false, status: 404, json: async () => null };
    }));
    withCtx({ role: 'admin', ...ORG_ADMIN });
    await mount({ projectId: 'proj-a' });
    await openAgentTab();
    expect(container.querySelector('[data-testid="agent-chats-admin-only"]')).toBeNull();
    expect(container.textContent).toContain(koMessages.chats.conversationsLoadFailed);
  });
});
