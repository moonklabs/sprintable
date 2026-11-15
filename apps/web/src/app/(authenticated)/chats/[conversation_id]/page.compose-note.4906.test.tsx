// @vitest-environment jsdom
//
// story 4906 (lap 3 · PO 11-14) — the home's one-line instruction is NOT sent when the person has no single agent DM (3831 «no receiver invented» · 4762): the chat list moves it to the
// most recent room and marks the arrival (`?compose=…&composeNote=k9x2ab`). The room then says, above its input, WHERE the line is (the room's NAME) and why it was not sent.
// This page builds that line (it knows the room); ChatView draws it above the composer. A room the person PICKED (`?compose=` alone) says nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../messages/ko.json';

const { useDashboardContextMock, searchParamsRef, chatViewProps } = vi.hoisted(() => ({
  useDashboardContextMock: vi.fn(),
  searchParamsRef: { current: '' as string },
  chatViewProps: { current: null as null | { composeNotice?: string; composeNoticeId?: string; initialComposeText?: string } },
}));

vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false, useIsBelowLg: () => false }));
vi.mock('next/navigation', () => ({
  useParams: () => ({ conversation_id: 'conv-1' }),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(searchParamsRef.current),
}));
// ChatView itself needs SSE (not in jsdom) — a stub that records the props the page hands it.
vi.mock('@/components/chat/chat-view', () => ({
  ChatView: (props: { composeNotice?: string; composeNoticeId?: string; initialComposeText?: string }) => { chatViewProps.current = props; return <div data-testid="chat-view-stub" />; },
}));
vi.mock('@/hooks/use-synthetic-parent-tab-history', () => ({ useSyntheticParentTabHistory: () => {} }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  searchParamsRef.current = '';
  chatViewProps.current = null;
  useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'me-1', projectId: 'proj-content', projectMemberships: [] });
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
});

function stubRoom(meta: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/api/conversations/conv-1')) return { ok: true, json: async () => meta };
    return { ok: true, json: async () => ({ data: [] }) };
  }));
}

async function mount() {
  const { default: ConversationPage } = await import('./page');
  const { TopBarProvider } = await import('@/components/nav/top-bar-context');
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <TopBarProvider><ConversationPage /></TopBarProvider>
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

describe('ConversationPage — «moved from 홈» note (4906)', () => {
  it('⭐ arrived by the list\'s hand-over (?compose + composeNote=k9x2ab): the room hands ChatView a note that names THIS room', async () => {
    searchParamsRef.current = `compose=${encodeURIComponent('릴리스 점검해 줘')}&composeNote=k9x2ab`;
    stubRoom({ title: 'MCP Repro', type: 'group', participants: [] });
    await mount();
    const note = chatViewProps.current?.composeNotice ?? '';
    expect(note).toContain('MCP Repro'); // reverted (no room name) → RED
    expect(note).toBe(koMessages.chats.composeMovedNotice.replace('{room}', 'MCP Repro'));
    expect(chatViewProps.current?.initialComposeText).toBe('릴리스 점검해 줘'); // the line itself still lands in the composer, unsent
    expect(chatViewProps.current?.composeNoticeId).toBe('k9x2ab'); // the hand-over's own id: the room's «done» memory is per room + id
  });

  it('a DM without a title is named by the other person (the head\'s own naming)', async () => {
    searchParamsRef.current = `compose=${encodeURIComponent('hi')}&composeNote=k9x2ab`;
    stubRoom({ title: null, type: 'dm', participants: [{ member_id: 'me-1', name: '나', type: 'human' }, { member_id: 'ag-1', name: '개발 에이전트', type: 'agent', resolved: true }] });
    await mount();
    expect(chatViewProps.current?.composeNotice).toContain('개발 에이전트');
  });

  it('⭐ a room the person PICKED (?compose alone) says nothing — only the auto hand-over is marked', async () => {
    searchParamsRef.current = `compose=${encodeURIComponent('hi')}`;
    stubRoom({ title: 'MCP Repro', type: 'group', participants: [] });
    await mount();
    expect(chatViewProps.current?.composeNotice).toBeUndefined();
    expect(chatViewProps.current?.composeNoticeId).toBeUndefined();
    expect(chatViewProps.current?.initialComposeText).toBe('hi');
  });

  it('⭐ an id that is not the list\'s own token (a hand-made or shared link) says nothing', async () => {
    searchParamsRef.current = `compose=${encodeURIComponent('hi')}&composeNote=${encodeURIComponent('<b>home</b>')}`;
    stubRoom({ title: 'MCP Repro', type: 'group', participants: [] });
    await mount();
    expect(chatViewProps.current?.composeNotice).toBeUndefined();
    expect(chatViewProps.current?.composeNoticeId).toBeUndefined();
  });

  it('a mark with no text to move says nothing', async () => {
    searchParamsRef.current = 'composeNote=k9x2ab'; // an id with no text to move
    stubRoom({ title: 'MCP Repro', type: 'group', participants: [] });
    await mount();
    expect(chatViewProps.current?.composeNotice).toBeUndefined();
  });
});
