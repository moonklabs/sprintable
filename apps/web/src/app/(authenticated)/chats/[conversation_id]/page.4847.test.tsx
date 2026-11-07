// @vitest-environment jsdom
//
// story 4847 (AC2 · AC3) — opening a room does not depend on, or change, the project the person is looking at: the room's own project (the server's
// single-room answer) is what the story/doc pickers and the attachments work in; the people to add come from the organization; a room that has no
// project of its own lets the person choose one.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../messages/ko.json';

const { useDashboardContextMock, routerMock } = vi.hoisted(() => ({
  useDashboardContextMock: vi.fn(),
  routerMock: { replace: vi.fn(), push: vi.fn() },
}));

vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ conversation_id: 'conv-1' }),
  useRouter: () => routerMock,
  useSearchParams: () => new URLSearchParams(''),
}));

// the ChatView needs SSE (EventSource, not in jsdom) — a stub that shows which project it was handed
vi.mock('@/components/chat/chat-view', () => ({
  ChatView: (props: { projectId?: string }) => <div data-testid="chat-view-stub" data-project={props.projectId ?? ''} />,
}));

vi.mock('@/hooks/use-synthetic-parent-tab-history', () => ({
  useSyntheticParentTabHistory: () => {},
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const A = { projectId: 'proj-a', projectName: '프로젝트 에이' };
const B = { projectId: 'proj-b', projectName: '프로젝트 비' };

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  routerMock.replace.mockClear();
  routerMock.push.mockClear();
  useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'me-1', projectId: 'proj-a', projectMemberships: [A, B] });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
});

function stubFetch(room: Record<string, unknown>) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === '/api/conversations/conv-1') {
      return { ok: true, status: 200, json: async () => ({ title: '회의', type: 'group', participants: [{ member_id: 'me-1', name: '나', type: 'human' }], ...room }) };
    }
    if (url.startsWith('/api/members')) return { ok: true, json: async () => ({ data: [{ id: 'm-b', name: '비 프로젝트 사람', type: 'human' }] }) };
    return { ok: true, status: 200, json: async () => ({ data: [] }) };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function mount() {
  const { default: ConversationPage } = await import('./page');
  const { TopBarProvider, useTopBar } = await import('@/components/nav/top-bar-context');
  function TopBarRenderer() {
    const { title, actions } = useTopBar();
    return <div>{title}{actions}</div>;
  }
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <TopBarProvider>
          <TopBarRenderer />
          <ConversationPage />
        </TopBarProvider>
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

const chatViewProject = () => container.querySelector('[data-testid="chat-view-stub"]')?.getAttribute('data-project');

describe('ConversationPage — 방의 프로젝트로 일한다(story 4847 AC2)', () => {
  it('⭐지금 프로젝트가 A여도 B의 방이면 ChatView(피커 · 첨부)는 B로 일한다 — 그리고 프로젝트를 바꾸는 이동은 없다', async () => {
    stubFetch({ project_id: 'proj-b' });
    await mount();
    expect(chatViewProject()).toBe('proj-b');
    expect(routerMock.replace).not.toHaveBeenCalled();
    expect(routerMock.push).not.toHaveBeenCalled();
  });

  it('⭐지금 프로젝트가 없어도(고른 것 없음) 방이 열리고 방의 프로젝트로 일한다', async () => {
    useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'me-1', projectId: '', projectMemberships: [A, B] });
    const fetchMock = stubFetch({ project_id: 'proj-b' });
    await mount();
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toContain('/api/conversations/conv-1');
    expect(chatViewProject()).toBe('proj-b');
  });

  it('방의 프로젝트가 아직 오지 않은 동안엔 ChatView에 프로젝트를 넘기지 않는다(지금 프로젝트로 대신하지 않는다)', async () => {
    useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'me-1', projectId: 'proj-a', projectMemberships: [A, B] });
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    await mount();
    expect(chatViewProject()).toBe('');
  });

  it('프로젝트가 있는 방에는 «프로젝트를 고르세요» 칸이 없다', async () => {
    stubFetch({ project_id: 'proj-b' });
    await mount();
    expect(container.querySelector('[data-testid="room-project-ask"]')).toBeNull();
  });
});

describe('ConversationPage — 방 정보를 못 읽었을 때 · 필드가 없을 때(story 4847, codex)', () => {
  it('⭐방 정보를 못 읽으면(403 아님) 조용히 프로젝트 없이 두지 않고 안내와 «다시 시도»를 보이고, 다시 읽으면 방의 프로젝트로 일한다', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/conversations/conv-1') {
        calls++;
        if (calls === 1) return { ok: false, status: 500, json: async () => null };
        return { ok: true, status: 200, json: async () => ({ title: '회의', type: 'group', participants: [], project_id: 'proj-b' }) };
      }
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    }));
    await mount();
    const notice = container.querySelector('[data-testid="room-info-failed"]');
    expect(notice).not.toBeNull();
    expect(notice!.textContent).toContain(koMessages.chats.roomInfoLoadFailed);
    expect(chatViewProject()).toBe('');
    const retry = [...notice!.querySelectorAll('button')].find((b) => b.textContent === koMessages.common.retry)!;
    await act(async () => { retry.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); await Promise.resolve(); });
    expect(container.querySelector('[data-testid="room-info-failed"]')).toBeNull();
    expect(chatViewProject()).toBe('proj-b');
  });

  it('⭐옛 응답에 project_id 필드가 아예 없으면 «프로젝트 없는 방»으로 읽지 않는다 — 고르는 칸도 안 뜨고 프로젝트도 짐작하지 않는다', async () => {
    stubFetch({}); // no project_id key at all
    await mount();
    expect(container.querySelector('[data-testid="room-project-ask"]')).toBeNull();
    expect(chatViewProject()).toBe('');
  });
});

describe('ConversationPage — 프로젝트 없는 방(story 4847 AC2 «없으면 고르게»)', () => {
  it('⭐프로젝트가 둘 이상이면 고르는 칸이 뜨고, 고르기 전엔 ChatView에 프로젝트가 없고 고르면 그 프로젝트로 일한다', async () => {
    stubFetch({ project_id: null });
    await mount();
    const ask = container.querySelector('[data-testid="room-project-ask"]');
    expect(ask).not.toBeNull();
    expect(chatViewProject()).toBe('');
    const select = container.querySelector('#room-project') as HTMLSelectElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, 'proj-b');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(chatViewProject()).toBe('proj-b');
  });

  it('쓸 수 있는 프로젝트가 하나뿐이면 묻지 않고 그 프로젝트로 일한다', async () => {
    useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'me-1', projectId: 'proj-a', projectMemberships: [A] });
    stubFetch({ project_id: null });
    await mount();
    expect(container.querySelector('[data-testid="room-project-ask"]')).toBeNull();
    expect(chatViewProject()).toBe('proj-a');
  });
});

describe('ConversationPage — 참가자 더하기는 조직 구성원에서 고른다(story 4847 AC3)', () => {
  it('⭐지금 프로젝트와 방의 프로젝트가 달라도, 구성원을 project_id 없이 읽는다', async () => {
    const fetchMock = stubFetch({ project_id: 'proj-b' });
    await mount();
    const add = [...container.querySelectorAll('button')].find((b) => b.title === koMessages.chats.addParticipants)!;
    await act(async () => { add.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const reads = fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith('/api/members'));
    expect(reads).toEqual(['/api/members?is_active=true']);
  });
});
