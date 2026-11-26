// @vitest-environment jsdom
//
// story 5032 (C2) — the chat list is TWO groups: the projects' channels (named by the project, «+ 새 채널» = a new project) and the one-to-one / group rooms. The server marks a channel `is_project_channel`; a room it
// does not mark (an older server too) stays in the second group. Structure pins — reverting the grouping, the channel's name or the «+ 새 채널» door turns them red.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import koMessages from '../../../messages/ko.json';
import { ChatListView } from './chat-list-view';
import { splitRooms } from './room-groups';

vi.mock('@/hooks/use-auto-refresh', () => ({ useAutoRefresh: () => {} }));
const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useSearchParams: () => new URLSearchParams('') }));
vi.mock('@/hooks/use-chat-sse', () => ({ useChatSse: () => ({ connected: true, polling: false }) }));
vi.mock('@/components/realtime-provider', () => ({
  useSseMultiplexerContext: () => ({ isAlive: () => false, subscribe: () => () => {}, subscribeMessage: () => () => {}, subscribeReconnect: () => () => {}, connected: true }),
}));
// the dialog host loads the switcher's state: the list only mounts it on the click — stubbed here, the host has its own test
vi.mock('./new-channel-dialog', () => ({ NewChannelDialogHost: ({ onClose }: { onClose: () => void }) => <div data-testid="new-channel-host"><button type="button" onClick={onClose}>x</button></div> }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  useDashboardContextMock.mockReturnValue({ projectMemberships: [{ projectId: 'p1', projectName: '런칭' }, { projectId: 'p2', projectName: '디자인' }], projectMembershipsFailed: false, orgMemberships: [], orgId: 'org-1' });
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

const ME = { member_id: 'me-1', name: '나', type: 'human' as const };
const HUMAN = { member_id: 'h-1', name: '지우', type: 'human' as const };
const AGENT = { member_id: 'a-1', name: '개발 에이전트', type: 'agent' as const, runtime_type: 'claude-code' };
const room = (id: string, extra: object = {}) => ({
  id, type: 'group', title: null, latest_message: { content: '안녕', created_at: '2026-11-26T09:00:00Z' }, updated_at: '2026-11-26T09:00:00Z', unread_count: 0, participants: [ME, HUMAN, AGENT], project_id: 'p1', project_name: '런칭', ...extra,
});

async function mount(convs: object[], canStartRoom = true) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/api/conversations/recent-outside-project')) return { ok: true, json: async () => ({ data: [] }) };
    if (url.includes('/api/conversations?')) return { ok: true, json: async () => ({ data: convs, total: convs.length }) };
    return { ok: false, status: 404, json: async () => null };
  }));
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><ChatListView projectId="p1" currentTeamMemberId="me-1" canStartRoom={canStartRoom} /></NextIntlClientProvider>); });
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
}
const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

describe('splitRooms (story 5032)', () => {
  it('only a room the server marks as a project channel is a channel; an unmarked one (an older server) is a room — each keeps its order', () => {
    const r = splitRooms([{ id: 'a' }, { id: 'b', is_project_channel: true }, { id: 'c', is_project_channel: false }, { id: 'd', is_project_channel: null }, { id: 'e', is_project_channel: true }]);
    expect(r.channels.map((x) => x.id)).toEqual(['b', 'e']);
    expect(r.rooms.map((x) => x.id)).toEqual(['a', 'c', 'd']);
  });
});

describe('[SID:5032] ChatListView — two groups', () => {
  it('⭐ the channels come first and the one-to-one / group rooms second, each under its own head with its own count', async () => {
    await mount([room('r1', { project_id: 'p2', project_name: '디자인', is_project_channel: true }), room('r2', { title: '점심', type: 'group' }), room('r3', { type: 'dm', participants: [ME, HUMAN] })]);
    const channels = q('chat-list-channels')!; const rooms = q('chat-list-room-group')!;
    expect(channels && rooms).toBeTruthy();
    expect(channels.compareDocumentPosition(rooms) & 4 /* DOCUMENT_POSITION_FOLLOWING */, 'the rooms group follows the channels group').toBe(4); // channels first
    expect(channels.querySelector('h3')?.textContent).toContain('채널');
    expect(rooms.querySelector('h3')?.textContent).toContain('일대일 · 그룹');
    expect(q('chat-list-channels-count')!.textContent).toBe('1');
    expect(q('chat-list-rooms-count')!.textContent).toBe('2');
    expect(channels.querySelector('[data-testid="room-row-glyph"] [data-icon]')?.getAttribute('data-icon'), 'a channel row wears the channel glyph').toBe('tag');
    expect(rooms.querySelector('[data-testid="room-row-glyph"] [data-icon="tag"]'), 'a room never does').toBeNull();
  });

  it('⭐ a channel row is named by its project (one channel per project) and carries no project line of its own; a room keeps the project line', async () => {
    await mount([room('r1', { project_id: 'p2', project_name: '디자인', title: null, is_project_channel: true }), room('r2', { title: '점심' })]);
    const channelRow = q('chat-list-channels')!;
    expect(channelRow.textContent).toContain('디자인');
    expect(channelRow.querySelector('[data-testid="room-project"]')).toBeNull();
    expect(q('chat-list-room-group')!.querySelector('[data-testid="room-project"]')?.textContent).toBe('런칭');
  });

  it('⭐ with no channel the head is still there and says so — and the second group holds every room (an older server marks none)', async () => {
    await mount([room('r1', { title: '점심' }), room('r2', { type: 'dm', participants: [ME, HUMAN] })]);
    expect(q('chat-list-channels-empty')!.textContent).toContain('아직 채널이 없어요');
    expect(q('chat-list-channels-count')!.textContent).toBe('0');
    expect(q('chat-list-rooms-count')!.textContent).toBe('2');
  });

  it('⭐ «+ 새 채널» is in the channels head and opens the new-channel dialog (the host is not mounted until then); a person who cannot start a room has no button', async () => {
    await mount([room('r1', { is_project_channel: true })]);
    const btn = q('chat-list-new-channel') as HTMLButtonElement;
    expect(btn.getAttribute('aria-label')).toBe('새 채널');
    expect(q('chat-list-channels')!.contains(btn)).toBe(true);
    expect(q('new-channel-host')).toBeNull();
    await act(async () => { btn.click(); });
    expect(q('new-channel-host')).not.toBeNull();
    await act(async () => { (q('new-channel-host')!.querySelector('button') as HTMLButtonElement).click(); });
    expect(q('new-channel-host')).toBeNull();
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await mount([room('r1', { is_project_channel: true })], false);
    expect(q('chat-list-new-channel')).toBeNull();
  });
});

// the teacher's rule (11-26 09:29Z, C2): talking about project B in a room of project A never opens a «switch to B?» popup or a suggestion — and there is none in the chat code today (measured). This pins the absence:
// no chat module detects · infers · suggests a project from what is said.
describe('[SID:5032] no project-detection popup in the chat code', () => {
  it('no non-test file under components/chat names a project detector or a project suggestion', () => {
    const dir = __dirname;
    const offenders: string[] = [];
    for (const f of readdirSync(dir)) {
      if (!/\.(ts|tsx)$/.test(f) || /\.test\./.test(f)) continue;
      const src = readFileSync(join(dir, f), 'utf8');
      if (/\b(detectProject|inferProject|suggestProject|projectSuggestion|guessProject|switchProjectPrompt)\b/.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});
