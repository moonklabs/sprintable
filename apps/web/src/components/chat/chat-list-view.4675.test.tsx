// @vitest-environment jsdom
//
// story 4675 (UX-1 · F2 · AC2 · Q-b) — a DM row with an agent names the agent's computer after the «에이전트» chip (the server's
// participant `device_name`); a group row says nothing (several computers); a DM whose agent has no computer has no chip.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ChatListView } from './chat-list-view';

vi.mock('@/hooks/use-auto-refresh', () => ({ useAutoRefresh: () => {} }));
const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useSearchParams: () => new URLSearchParams('') }));
vi.mock('@/hooks/use-chat-sse', () => ({ useChatSse: () => ({ connected: true, polling: false }) }));
vi.mock('@/components/realtime-provider', () => ({
  useSseMultiplexerContext: () => ({ isAlive: () => false, subscribe: () => () => {}, subscribeMessage: () => () => {}, subscribeReconnect: () => () => {}, connected: true }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); useDashboardContextMock.mockReturnValue({ role: 'member' }); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

const ME = { member_id: 'me-1', name: '나', type: 'human' as const };
const AGENT = (device_name: string | null) => ({ member_id: 'a-1', name: '조사', type: 'agent' as const, runtime_type: 'claude-code', device_name });
const conv = (id: string, type: 'dm' | 'group', participants: object[]) => ({
  id, type, title: type === 'group' ? '모임' : null, latest_message: { content: '안녕', created_at: '2026-10-13T09:00:00Z' }, updated_at: '2026-10-13T09:00:00Z', unread_count: 0, participants,
});

async function mount(convs: object[]) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/api/conversations/recent-outside-project')) return { ok: true, json: async () => ({ data: [] }) };
    if (url.includes('/api/conversations?')) return { ok: true, json: async () => ({ data: convs, total: convs.length }) };
    return { ok: false, status: 404, json: async () => null };
  }));
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><ChatListView projectId="proj-current" currentTeamMemberId="me-1" /></NextIntlClientProvider>); });
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
}

describe('[SID:4675] ChatListView — the computer chip on a DM row', () => {
  it('DM with an agent → the chip after «에이전트» · a group row → none · an agent with no computer → none', async () => {
    await mount([
      conv('c-dm', 'dm', [ME, AGENT('yoonjae의 맥')]),
      conv('c-group', 'group', [ME, AGENT('yoonjae의 맥'), { member_id: 'h-2', name: '유나', type: 'human' }]),
      conv('c-dm-none', 'dm', [ME, { ...AGENT(null), member_id: 'a-2', name: '작성' }]),
    ]);
    const rowOf = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) as HTMLElement;
    const dm = rowOf('조사');
    expect(dm).toBeTruthy();
    const chip = dm.querySelector('[data-testid=device-chip]');
    expect(chip?.textContent).toBe('yoonjae의 맥'); // reverted → undefined
    // after the «에이전트» chip in the same line
    const agentWord = [...dm.querySelectorAll('span')].find((s) => s.textContent === koMessages.chats.agent)!;
    expect(agentWord.compareDocumentPosition(chip!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(rowOf('모임').querySelector('[data-testid=device-chip]')).toBeNull();
    expect(rowOf('작성').querySelector('[data-testid=device-chip]')).toBeNull();
  });
});
