// @vitest-environment jsdom
//
// story 5031 (org-switch defect) — after the person switches ORGANIZATION the chat list kept the old organization's rooms.
// The organization-wide ask (`/api/conversations?limit=…&offset=0`) carries no organization in its URL — the organization rides on the session (the fetch interceptor's X-Org-Id) —
// and `fetchConversations` did not list the organization among its dependencies, so when the screen was not remounted (the chats layout holds ONE ChatListView) nothing asked again.
// What is pinned here: ① the organization changes → clear · «불러오는 중…» · ask again · the new organization's answer; ② the SAME organization with another current project → the
// organization-wide list is not asked again and not cleared (only the agents tab asks); ③ the project-only fallback still asks again on a project change; ④ a late answer of the old
// organization never lands on the new organization's list. The context is a mock: the tests change its `orgId` and render again (there is no real two-organization account here).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ChatListView, CHAT_PROJECT_FILTER_KEY } from './chat-list-view';

vi.mock('@/hooks/use-auto-refresh', () => ({ useAutoRefresh: () => {} }));

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));
vi.mock('@/hooks/use-chat-sse', () => ({ useChatSse: () => ({ connected: true, polling: false }) }));
vi.mock('@/components/realtime-provider', () => ({
  useSseMultiplexerContext: () => ({ isAlive: () => false, subscribe: () => () => {}, subscribeMessage: () => () => {}, subscribeReconnect: () => () => {}, connected: true }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

// organization ids no other test uses (the domain-labels hook caches per organization)
const ORG_A = 'org-5031-orgsw-a';
const ORG_B = 'org-5031-orgsw-b';
const PA1 = { projectId: 'proj-a1', projectName: '에이 하나' };
const PA2 = { projectId: 'proj-a2', projectName: '에이 둘' };
const PB1 = { projectId: 'proj-b1', projectName: '비 하나' };
const ORG_LIST = [
  { orgId: ORG_A, orgName: 'A', orgSlug: 'a', role: 'admin' },
  { orgId: ORG_B, orgName: 'B', orgSlug: 'b', role: 'admin' },
];

const room = (id: string, title: string, projectId: string, at: string) => ({
  id, type: 'group', title, latest_message: null, updated_at: at, unread_count: 0, project_id: projectId, project_name: null,
});
const RA = room('conv-oa', '에이 조직 방', PA1.projectId, '2026-11-07T01:00:00Z');
const RB = room('conv-ob', '비 조직 방', PB1.projectId, '2026-11-07T02:00:00Z');

const ctxOf = (org: string, projectId: string | undefined, extra: Record<string, unknown> = {}) => ({
  orgId: org, orgMemberships: ORG_LIST, projectMemberships: org === ORG_A ? [PA1, PA2] : [PB1], role: 'member', projectId, ...extra,
});

function wrap(node: React.ReactNode) {
  return <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>;
}

/**
 * A server that answers for the organization the SESSION is in (the URL never says which): `server.org` is the session's organization at the moment an ask LEAVES (captured then, so a held
 * ask of the old organization still carries the old organization's rooms when it is finally answered). `holdOrg` makes the asks of that organization wait until `release()`.
 */
const server = { org: ORG_A, holdOrg: null as string | null, gates: [] as Array<() => void>, orgWide422: false };
const release = () => { const g = server.gates.splice(0); g.forEach((f) => f()); };
function stubServer() {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.includes('/api/conversations/recent-outside-project')) return { ok: true, json: async () => ({ data: [] }) };
    if (url.startsWith('/api/conversations?')) {
      const asked = server.org;
      const q = new URL(url, 'http://x').searchParams;
      if (server.holdOrg === asked) await new Promise<void>((resolve) => { server.gates.push(resolve); });
      if (server.orgWide422 && !q.has('project_id')) return { ok: false, status: 422, json: async () => ({}) };
      const all = asked === ORG_A ? [RA] : [RB];
      const rows = q.has('project_id') && q.get('project_id') !== 'none' && q.get('include_agent_conversations') !== 'true' ? all.filter((r) => r.project_id === q.get('project_id')) : all;
      return { ok: true, json: async () => ({ data: rows, total: rows.length }) };
    }
    return { ok: false, status: 404, json: async () => null };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const listCalls = (m: ReturnType<typeof vi.fn>) => m.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith('/api/conversations?'));
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }); };

async function mountIn(org: string, projectId: string | undefined, extra: Record<string, unknown> = {}) {
  server.org = org;
  useDashboardContextMock.mockReturnValue(ctxOf(org, projectId, extra));
  await act(async () => { root.render(wrap(<ChatListView projectId={projectId ?? null} currentTeamMemberId="me-1" />)); });
  await flush();
}
/** the person switched: the session (server) is in `org` now, and the shell hands the new context to the same, still mounted, list */
async function switchTo(org: string, projectId: string | undefined, props: { projectId?: string | null } = {}, extra: Record<string, unknown> = {}) {
  server.org = org;
  useDashboardContextMock.mockReturnValue(ctxOf(org, projectId, extra));
  await act(async () => { root.render(wrap(<ChatListView projectId={props.projectId !== undefined ? props.projectId : projectId ?? null} currentTeamMemberId="me-1" />)); });
  await flush();
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  server.org = ORG_A; server.holdOrg = null; server.gates = []; server.orgWide422 = false;
  window.sessionStorage.removeItem(CHAT_PROJECT_FILTER_KEY);
});
afterEach(async () => {
  release();
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  window.sessionStorage.removeItem(CHAT_PROJECT_FILTER_KEY);
});

describe('ChatListView — 조직을 바꾸면 목록이 새 조직의 방이다(story 5031)', () => {
  it('⭐① 조직 A→B(현재 프로젝트도 함께 바뀜): 목록을 비우고 «불러오는 중…»을 세우고 다시 묻는다 — 응답이 오면 B의 방뿐이다', async () => {
    const fetchMock = stubServer();
    await mountIn(ORG_A, PA1.projectId);
    expect(container.textContent).toContain('에이 조직 방');
    expect(listCalls(fetchMock)).toEqual(['/api/conversations?limit=30&offset=0']);
    server.holdOrg = ORG_B;
    await switchTo(ORG_B, PB1.projectId);
    expect(listCalls(fetchMock)).toEqual(['/api/conversations?limit=30&offset=0', '/api/conversations?limit=30&offset=0']); // asked again (reverted → still one)
    expect(container.querySelector(`[data-slot="ds-skeleton-group"][aria-label="${koMessages.common.loading}"]`)).not.toBeNull(); // …and says so while it waits
    expect(container.textContent).not.toContain('에이 조직 방'); // the old organization's room is gone at once, not left until the answer
    await act(async () => { release(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain('비 조직 방');
    expect(container.textContent).not.toContain('에이 조직 방');
    expect(container.querySelector(`[data-slot="ds-skeleton-group"][aria-label="${koMessages.common.loading}"]`)).toBeNull();
  });

  it('⭐① 조직만 바뀌고 화면에 건넨 프로젝트는 그대로여도(셸이 두 값을 한 번에 못 건넬 때) 다시 묻는다', async () => {
    const fetchMock = stubServer();
    await mountIn(ORG_A, PA1.projectId);
    await switchTo(ORG_B, PA1.projectId, { projectId: PA1.projectId });
    expect(listCalls(fetchMock)).toHaveLength(2);
    expect(container.textContent).toContain('비 조직 방');
    expect(container.textContent).not.toContain('에이 조직 방');
  });

  it('⭐① 옛 조직에서 골라 둔 «프로젝트로 걸러 보기»는 새 조직에 실리지 않는다 — 옛 프로젝트 id를 단 물음이 한 번도 나가지 않고(깜빡임 없음), 저장도 지워진다', async () => {
    window.sessionStorage.setItem(CHAT_PROJECT_FILTER_KEY, PA2.projectId); // chosen in organization A
    const fetchMock = stubServer();
    await mountIn(ORG_A, PA1.projectId);
    expect(listCalls(fetchMock)).toEqual([`/api/conversations?limit=30&offset=0&project_id=${PA2.projectId}`]);
    await switchTo(ORG_B, PB1.projectId);
    const after = listCalls(fetchMock).slice(1);
    expect(after).toEqual(['/api/conversations?limit=30&offset=0']); // ONE ask, with no project of the old organization (reverted → two: the old filter first, then the plain one)
    expect(window.sessionStorage.getItem(CHAT_PROJECT_FILTER_KEY)).toBeNull();
    expect(container.textContent).toContain('비 조직 방');
  });

  it('⭐④ 옛 조직의 물음이 B의 목록이 선 뒤에야 돌아와도 B의 목록을 덮지 않는다(조직 전환 길)', async () => {
    server.holdOrg = ORG_A; // the first ask (organization A) hangs
    const fetchMock = stubServer();
    await mountIn(ORG_A, PA1.projectId);
    expect(container.querySelector(`[data-slot="ds-skeleton-group"][aria-label="${koMessages.common.loading}"]`)).not.toBeNull();
    server.holdOrg = null;
    await switchTo(ORG_B, PB1.projectId); // B asks, is answered at once
    expect(container.textContent).toContain('비 조직 방');
    expect(listCalls(fetchMock)).toHaveLength(2);
    await act(async () => { release(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }); // …now A's answer arrives (A's rooms)
    expect(container.textContent).toContain('비 조직 방');
    expect(container.textContent).not.toContain('에이 조직 방');
    expect(container.querySelector(`[data-slot="ds-skeleton-group"][aria-label="${koMessages.common.loading}"]`)).toBeNull();
  });

  // codex (round 1 on 1d5dcb35): with a stored filter the first version cleared it in an EFFECT and returned before asking — in the gap before the re-render an answer of the old ask could still pass the stale guard.
  // The choice is dropped in the render the new organization arrives, so there is no gap: the old organization's FILTERED ask (held) can come back at any time and never lands.
  it('⭐④ 걸러 보기를 단 옛 조직의 물음이 멈춰 있다가 조직 전환 뒤에 돌아와도 새 조직의 목록을 덮지 않는다(걸러 보기 비움 길)', async () => {
    window.sessionStorage.setItem(CHAT_PROJECT_FILTER_KEY, PA2.projectId);
    server.holdOrg = ORG_A; // A's FILTERED ask hangs
    const fetchMock = stubServer();
    await mountIn(ORG_A, PA1.projectId);
    expect(listCalls(fetchMock)).toEqual([`/api/conversations?limit=30&offset=0&project_id=${PA2.projectId}`]);
    server.holdOrg = null;
    await switchTo(ORG_B, PB1.projectId);
    expect(listCalls(fetchMock).slice(1)).toEqual(['/api/conversations?limit=30&offset=0']);
    expect(container.textContent).toContain('비 조직 방');
    await act(async () => { release(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain('비 조직 방');
    expect(container.textContent).not.toContain('에이 조직 방');
    expect(container.querySelector(`[data-slot="ds-skeleton-group"][aria-label="${koMessages.common.loading}"]`)).toBeNull();
  });

  it('⭐① StrictMode(개발 서버)에서도 같다 — 조직 전환 뒤 물음은 옛 프로젝트 id 없이 한 번, 저장은 비워진다', async () => {
    window.sessionStorage.setItem(CHAT_PROJECT_FILTER_KEY, PA2.projectId);
    const fetchMock = stubServer();
    const strict = (org: string, projectId: string) => {
      server.org = org;
      useDashboardContextMock.mockReturnValue(ctxOf(org, projectId));
      return act(async () => { root.render(<StrictMode>{wrap(<ChatListView projectId={projectId} currentTeamMemberId="me-1" />)}</StrictMode>); });
    };
    await strict(ORG_A, PA1.projectId);
    await flush();
    const before = listCalls(fetchMock).length;
    await strict(ORG_B, PB1.projectId);
    await flush();
    const after = listCalls(fetchMock).slice(before);
    expect(after, 'ONE ask for the switch (an update runs the effect once, StrictMode or not)').toHaveLength(1);
    expect(after.every((u) => u === '/api/conversations?limit=30&offset=0'), `no ask of the switch carries the old project: ${after.join(' | ')}`).toBe(true);
    expect(window.sessionStorage.getItem(CHAT_PROJECT_FILTER_KEY)).toBeNull();
    expect(container.textContent).toContain('비 조직 방');
  });

  // codex (round 1): an organization the context only learns LATE is the first look, not a switch — the stored choice is not thrown away by the organization rule (the «not one of the person's projects» effect judges it, as before this change);
  // the next real switch A → B still drops it.
  it('조직을 늦게 알게 되는 경우(마운트 때 비어 있던 조직)는 «전환»이 아니라 처음 기록이다 — 저장된 걸러 보기는 그대로 · 그 뒤 A→B에서는 비운다', async () => {
    window.sessionStorage.setItem(CHAT_PROJECT_FILTER_KEY, PA2.projectId);
    const fetchMock = stubServer();
    server.org = ORG_A;
    useDashboardContextMock.mockReturnValue({ ...ctxOf(ORG_A, PA1.projectId), orgId: undefined });
    await act(async () => { root.render(wrap(<ChatListView projectId={PA1.projectId} currentTeamMemberId="me-1" />)); });
    await flush();
    await switchTo(ORG_A, PA1.projectId); // the organization becomes known: recorded only
    expect(window.sessionStorage.getItem(CHAT_PROJECT_FILTER_KEY), 'a late first look is not a switch').toBe(PA2.projectId);
    expect(listCalls(fetchMock).every((u) => u.includes(`project_id=${PA2.projectId}`))).toBe(true);
    await switchTo(ORG_B, PB1.projectId); // a real switch now
    expect(window.sessionStorage.getItem(CHAT_PROJECT_FILTER_KEY)).toBeNull();
    expect(listCalls(fetchMock).at(-1)).toBe('/api/conversations?limit=30&offset=0');
    expect(container.textContent).toContain('비 조직 방');
  });
});

describe('ChatListView — 걸러 보기가 «내 프로젝트가 아닌» 채로 물음에 실리지 않는다(story 5031 · codex 판 2)', () => {
  // the two guards are separate: «not mine» (below) cannot help when the shell shows the NEW organization while the person's project list is still the OLD organization's (the old choice still looks like theirs) —
  // only dropping the choice in the render the organization changes keeps that ask clean.
  it('새 조직이 먼저 오고 프로젝트 목록은 아직 옛 조직 것이어도(옛 걸러 보기가 «내 프로젝트»로 보임) 옛 프로젝트 id를 단 물음이 나가지 않는다', async () => {
    window.sessionStorage.setItem(CHAT_PROJECT_FILTER_KEY, PA2.projectId);
    const fetchMock = stubServer();
    await mountIn(ORG_A, PA1.projectId);
    const before = listCalls(fetchMock).length;
    await switchTo(ORG_B, PB1.projectId, {}, { projectMemberships: [PA1, PA2] }); // organization B, project list still A's
    const after = listCalls(fetchMock).slice(before);
    expect(after.some((u) => u.includes(PA2.projectId)), `no ask carries the old project even while the list lags: ${after.join(' | ')}`).toBe(false);
    expect(after).toEqual(['/api/conversations?limit=30&offset=0']);
    expect(window.sessionStorage.getItem(CHAT_PROJECT_FILTER_KEY)).toBeNull();
  });

  it('조직을 늦게 알게 되었는데 저장된 걸러 보기가 그 조직의 내 프로젝트가 아니면: 그 id를 단 물음은 나가지 않고, 걸러 보기는 비워지고, 저장도 지워진다', async () => {
    window.sessionStorage.setItem(CHAT_PROJECT_FILTER_KEY, PA2.projectId); // chosen when the person was in organization A
    const fetchMock = stubServer();
    server.org = ORG_B;
    // the context is empty of an organization at mount but already lists the stored project as the person's (so the first read keeps it)…
    useDashboardContextMock.mockReturnValue({ ...ctxOf(ORG_B, PB1.projectId), orgId: undefined, projectMemberships: [PA2] });
    await act(async () => { root.render(wrap(<ChatListView projectId={PB1.projectId} currentTeamMemberId="me-1" />)); });
    await flush();
    const before = listCalls(fetchMock).length;
    // …then the shell knows the organization (B) and B's projects: the stored one is not among them
    useDashboardContextMock.mockReturnValue(ctxOf(ORG_B, PB1.projectId));
    await act(async () => { root.render(wrap(<ChatListView projectId={PB1.projectId} currentTeamMemberId="me-1" />)); });
    await flush();
    const after = listCalls(fetchMock).slice(before);
    expect(after.some((u) => u.includes(PA2.projectId)), `no ask carries the other organization's project: ${after.join(' | ')}`).toBe(false);
    expect(after.at(-1)).toBe('/api/conversations?limit=30&offset=0');
    expect(window.sessionStorage.getItem(CHAT_PROJECT_FILTER_KEY)).toBeNull();
    expect(container.textContent).toContain('비 조직 방');
  });
});

describe('ChatListView — 같은 조직 안에서 현재 프로젝트만 바뀔 때(story 5031 · 깜빡임 없음)', () => {
  it('⭐② 조직 전체 목록은 다시 묻지도 비우지도 않는다 — 다시 물었다면 멈춰 둔 응답 때문에 «불러오는 중…»이 떠 있었을 것이다', async () => {
    const fetchMock = stubServer();
    await mountIn(ORG_A, PA1.projectId);
    server.holdOrg = ORG_A; // if it asked again the answer would hang here and the screen would sit in «불러오는 중…»
    await switchTo(ORG_A, PA2.projectId);
    expect(listCalls(fetchMock)).toHaveLength(1);
    expect(container.textContent).toContain('에이 조직 방'); // the list it had, untouched
    expect(container.querySelector(`[data-slot="ds-skeleton-group"][aria-label="${koMessages.common.loading}"]`)).toBeNull();
  });

  it('⭐② 에이전트 탭만 새 프로젝트로 다시 묻는다(조직 전체 목록은 그대로) — 새 대화의 프로젝트 기본값도 새 프로젝트다', async () => {
    const fetchMock = stubServer();
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia;
    await mountIn(ORG_A, PA1.projectId);
    const trigger = container.querySelector('[data-testid="chat-list-options"]') as HTMLElement;
    await act(async () => { trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); await Promise.resolve(); });
    const tab = [...document.querySelectorAll('[data-testid="chat-list-tabs"] button')].find((b) => b.textContent === koMessages.chats.agentChatsTab)!;
    await act(async () => { tab.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    const before = listCalls(fetchMock);
    expect(before.at(-1)).toBe(`/api/conversations?project_id=${PA1.projectId}&include_agent_conversations=true&limit=30&offset=0`);
    await switchTo(ORG_A, PA2.projectId);
    const after = listCalls(fetchMock).slice(before.length);
    expect(after).toEqual([`/api/conversations?project_id=${PA2.projectId}&include_agent_conversations=true&limit=30&offset=0`]); // the agents tab asks; the organization-wide list does not
    // the «새 대화» window opens on the NEW project
    await act(async () => { root.render(wrap(<ChatListView projectId={PA2.projectId} currentTeamMemberId="me-1" open onOpenChange={() => {}} />)); });
    await flush();
    expect((document.body.querySelector('#new-room-project') as HTMLSelectElement).value).toBe(PA2.projectId);
  });

  it('⭐③ 옛 서버(조직 전체 422)의 프로젝트 단위 목록은 현재 프로젝트가 바뀌면 그 프로젝트로 다시 묻는다(그대로)', async () => {
    server.orgWide422 = true;
    const fetchMock = stubServer();
    await mountIn(ORG_A, PA1.projectId);
    expect(listCalls(fetchMock)).toEqual(['/api/conversations?limit=30&offset=0', `/api/conversations?limit=30&offset=0&project_id=${PA1.projectId}`]);
    expect(container.textContent).toContain('에이 조직 방');
    await switchTo(ORG_A, PA2.projectId);
    expect(listCalls(fetchMock).at(-1)).toBe(`/api/conversations?limit=30&offset=0&project_id=${PA2.projectId}`);
    expect(listCalls(fetchMock)).toHaveLength(3);
  });
});
