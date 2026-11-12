// @vitest-environment jsdom
//
// story 4906 — the list rail of a new organization says what to do next (the wiring through ChatListView; the pieces are in no-peers-next-steps.4906.test.tsx)
// (boilerplate as chat-list-view.4847.test.tsx)
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

const ME = 'me-1';
const wrap = (node: React.ReactNode) => <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>;
const A = { projectId: 'proj-a', projectName: '프로젝트 에이' };

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  searchParamsValueRef.current = '';
  useDashboardContextMock.mockReturnValue({ projectMemberships: [A], role: 'owner', projectId: undefined, currentTeamMemberId: ME, orgId: 'org-1', orgMemberships: [{ orgId: 'org-1', orgName: 'O', orgSlug: 'o', role: 'owner' }] });
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  window.sessionStorage.removeItem(CHAT_PROJECT_FILTER_KEY);
});

/** no rooms at all; the roster read answers `roster` */
function stubEmptyOrg(roster: Array<Record<string, unknown>>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/api/conversations/recent-outside-project')) return { ok: true, json: async () => ({ data: [] }) };
    if (url.startsWith('/api/conversations?')) return { ok: true, json: async () => ({ data: [], total: 0 }) };
    if (url.startsWith('/api/members')) return { ok: true, json: async () => ({ data: roster }) };
    return { ok: false, status: 404, json: async () => null };
  }));
}
async function mountList() {
  await act(async () => { root.render(wrap(<ChatListView projectId={null} currentTeamMemberId={ME} />)); });
  await act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); });
}

describe('ChatListView — the first conversation of a new organization is not a dead end (story 4906)', () => {
  it('⭐no rooms and nobody but me to talk to → the rail says so and links to add an agent / invite (not «새 대화를 시작해보세요»)', async () => {
    stubEmptyOrg([{ id: ME, name: '나', type: 'human' }]);
    await mountList();
    expect(container.querySelector('[data-testid="chat-no-peers"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="chat-no-peers-add-agent"]')).not.toBeNull();
    expect(container.textContent).not.toContain(koMessages.chats.startNewConversation);
  });

  it('⭐no rooms but somebody to talk to → the ordinary empty state', async () => {
    stubEmptyOrg([{ id: ME, name: '나', type: 'human' }, { id: 'a-bot', name: '점검봇', type: 'agent' }]);
    await mountList();
    expect(container.querySelector('[data-testid="chat-no-peers"]')).toBeNull();
    expect(container.textContent).toContain(koMessages.chats.startNewConversation);
  });
});
