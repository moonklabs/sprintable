// @vitest-environment jsdom
//
// story 4887 (UI-4 P2-c) — the DM row's participant line: ONE line that never runs past the column. «나 ↔ 상대» is one plain text segment that gives way first, the «에이전트» chip keeps its size,
// the computer chip may shrink to an ellipsis; nothing it said is dropped. jsdom measures no layout, so the sizing decisions are pinned as the classes that make them (the real widths are the dev «후» measurement).
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
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); useDashboardContextMock.mockReturnValue({ projectMemberships: [], role: 'member' }); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

const ME = { member_id: 'me-1', name: '나', type: 'human' as const };
const AGENT = { member_id: 'a-1', name: '개발 에이전트', type: 'agent' as const, runtime_type: 'claude-code', device_name: 'AC4 isolated daemon on a very long computer name' };
const HUMAN = { member_id: 'h-1', name: '지우', type: 'human' as const };
const conv = (id: string, participants: object[], title: string | null = null) => ({
  id, type: 'dm', title, latest_message: { content: '안녕', created_at: '2026-10-13T09:00:00Z' }, updated_at: '2026-10-13T09:00:00Z', unread_count: 0, participants,
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
const lines = () => [...container.querySelectorAll('[data-testid="room-dm-line"]')] as HTMLElement[];

describe('[SID:4887] ChatListView — the DM line (P2-c)', () => {
  it('⭐ a person\'s DM titled with the other\'s own name has NO participant line at all — the title and the avatar already say who it is with', async () => {
    await mount([conv('c1', [ME, HUMAN])]);
    expect(lines()).toHaveLength(0); // reverted → the line is back with «나 ↔ 지우»
    expect(container.textContent).toContain('지우'); // the title still says it
    expect(container.textContent).not.toContain('나 ↔');
  });

  it('⭐ a DM the people NAMED keeps the other\'s name on the line — without «나 ↔» — so «who is this with» never disappears', async () => {
    await mount([conv('c1', [ME, HUMAN], '점심 약속')]);
    const other = container.querySelector('[data-testid="room-dm-other"]') as HTMLElement;
    expect(other.textContent).toBe('지우'); // reverted (always dropped) → null
    expect(other.className).toContain('min-w-0');
    expect(other.className).toContain('truncate');
    expect(other.className).not.toContain('bg-muted'); // no pill
    expect(container.textContent).not.toContain('나 ↔');
  });

  it('⭐ an agent DM titled with the agent\'s name shows NO name segment — the line is the «에이전트» chip and the computer chip, and they get the width', async () => {
    await mount([conv('c1', [ME, AGENT])]);
    const line = lines()[0]!;
    expect(line.querySelector('[data-testid="room-dm-other"]')).toBeNull();
    expect(line.firstElementChild!.textContent).toBe(koMessages.chats.agent); // the agent chip leads
    expect(line.querySelector('[data-testid="device-chip"]')).not.toBeNull();
  });

  it('⭐ an agent DM the people named keeps the agent\'s name before its chips', async () => {
    await mount([conv('c1', [ME, AGENT], '배포 도우미')]);
    expect((lines()[0]!.querySelector('[data-testid="room-dm-other"]') as HTMLElement).textContent).toBe('개발 에이전트');
  });

  it('⭐ the line cannot run past the column — it clips at its own edge and never lets a child push it wider', async () => {
    await mount([conv('c1', [ME, AGENT])]);
    const line = lines()[0]!;
    expect(line.className).toContain('min-w-0');
    expect(line.className).toContain('overflow-hidden'); // reverted → the chip is cut by the row instead
    expect(line.className).toContain('flex');
  });

  it('⭐ the computer chip shrinks to an ellipsis (min-w-0, not shrink-0) and still carries its whole name in the title', async () => {
    await mount([conv('c1', [ME, AGENT])]);
    const chip = container.querySelector('[data-testid="device-chip"]') as HTMLElement;
    expect(chip).toBeTruthy();
    expect(chip.className).toContain('min-w-0');
    expect(chip.className).not.toContain('shrink-0'); // reverted → `shrink-0`: the chip is cut mid-word at 320 px
    expect(chip.getAttribute('title')).toBe(AGENT.device_name);
    expect(chip.querySelector('.truncate')?.textContent).toBe(AGENT.device_name);
  });

  it('⭐ the «에이전트» chip keeps its size (shrink-0) and still comes before the computer chip; everything the line said is still there', async () => {
    await mount([conv('c1', [ME, AGENT])]);
    const line = lines()[0]!;
    const agentChip = [...line.querySelectorAll('span')].find((s) => s.textContent === koMessages.chats.agent) as HTMLElement;
    expect(agentChip.className).toContain('flex-shrink-0');
    const chip = line.querySelector('[data-testid="device-chip"]')!;
    expect(agentChip.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('⭐ the row is a little tighter (py-2) — the room list shows more rooms per screen', async () => {
    await mount([conv('c1', [ME, HUMAN])]);
    const row = container.querySelector('button') as HTMLElement;
    expect(row.className).toContain('py-2 ');
    expect(row.className).not.toContain('py-2.5'); // reverted → the old padding
  });
});
