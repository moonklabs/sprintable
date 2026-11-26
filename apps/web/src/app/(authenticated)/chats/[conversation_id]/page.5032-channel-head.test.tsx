// @vitest-environment jsdom
//
// story 5032 (C2) — a project channel's room head: the tag «채널», the line «사람 N · 부를 수 있는 에이전트 N», and a named settings cog that opens the channel settings window (story 5032: per-agent «모든 말 받기», and a button to the room's own delivery dialog); a one-to-one / group room has none of these.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../messages/ko.json';

const { useDashboardContextMock } = vi.hoisted(() => ({
  useDashboardContextMock: vi.fn(),
}));

vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ conversation_id: 'conv-1' }),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));

vi.mock('@/components/chat/chat-view', () => ({
  ChatView: () => <div data-testid="chat-view-stub" />,
}));

vi.mock('@/hooks/use-synthetic-parent-tab-history', () => ({
  useSyntheticParentTabHistory: () => {},
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'me-1', projectId: 'proj-content', projectMemberships: [] });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
});

function stubFetch(channel: boolean) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/api/conversations/conv-1')) {
      return {
        ok: true,
        json: async () => ({
          title: channel ? '런칭' : '점심', type: 'group', muted: false, last_read_at: null, free_response: false, project_id: 'proj-content', is_project_channel: channel,
          participants: [
            { member_id: 'me-1', name: '나', avatar_url: null, type: 'human' },
            { member_id: 'them-1', name: '유나', avatar_url: null, type: 'human' },
            { member_id: 'ag-1', name: '개발 에이전트', avatar_url: null, type: 'agent', runtime_type: 'claude-code' },
          ],
        }),
      };
    }
    return { ok: true, json: async () => ({ data: [] }) };
  }));
}

async function mount() {
  const { default: ConversationPage } = await import('./page');
  const { TopBarProvider } = await import('@/components/nav/top-bar-context');
  const { ToastProvider } = await import('@/components/ui/toast');
  await act(async () => { root.render(wrap(<ToastProvider><TopBarProvider><ConversationPage /></TopBarProvider></ToastProvider>)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}
const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

describe('[SID:5032] ConversationPage — the channel head', () => {
  it('⭐ a channel says «채널» and «사람 2 · 부를 수 있는 에이전트 1» (the humans and the agents of the room, counted apart) and has a named settings cog', async () => {
    stubFetch(true); await mount();
    expect(q('room-head-tag')?.textContent).toBe('채널');
    expect(q('room-head-subline')?.textContent).toBe('사람 2 · 부를 수 있는 에이전트 1');
    const cog = q('room-head-channel-settings');
    expect(cog, 'the cog is on the channel head').not.toBeNull();
    expect(cog!.getAttribute('aria-label')).toBe('채널 설정');
  });

  it('⭐ the cog opens the CHANNEL settings window (the per-agent «모든 말 받기»), not the delivery dialog', async () => {
    stubFetch(true); await mount();
    await act(async () => { q('room-head-channel-settings')!.click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(document.querySelector('[data-testid="channel-settings"]')).not.toBeNull(); // reverted → the old delivery dialog opens
    expect(document.body.textContent).toContain(koMessages.chats.channelReceiveAllTitle);
    expect(document.body.textContent).not.toContain(koMessages.chats.deliveryContractLevelLabel);
  });

  it('⭐ «내 알림 설정» in the channel window opens the delivery dialog, which gives focus back to the cog (not to the «⋯» menu)', async () => {
    stubFetch(true); await mount();
    const cog = q('room-head-channel-settings') as HTMLButtonElement;
    await act(async () => { cog.focus(); cog.click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const mine = document.querySelector('[data-testid="channel-open-my-notifications"]') as HTMLButtonElement;
    expect(mine, 'the channel window has the «내 알림 설정» button').toBeTruthy();
    await act(async () => { mine.click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(document.querySelector('[data-testid="channel-settings"]')).toBeNull();
    expect(document.body.textContent).toContain(koMessages.chats.deliveryContractTitle);
    const closeBtn = [...document.querySelectorAll('button')].find((b) => /닫기|취소/.test(b.textContent ?? '')) as HTMLButtonElement | undefined;
    expect(closeBtn, 'the dialog has a close/cancel button').toBeTruthy();
    await act(async () => { closeBtn!.click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(document.activeElement === cog, 'focus is back on the cog').toBe(true);
  });

  it('⭐ a room of a project says the project ONCE, as the head chip (its name), and the line is «N명» only; a room with no project says its kind', async () => {
    useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'me-1', projectId: 'proj-content', projectMemberships: [{ projectId: 'proj-content', projectName: '런칭' }] });
    stubFetch(false); await mount();
    expect(q('room-head-tag')?.textContent).toBe('런칭'); // reverted → «프로젝트 방»
    expect(q('room-head-subline')?.textContent).toBe('3명'); // the name is not repeated on the line
  });

  it('⭐ a one-to-one / group room keeps its own head: no channel tag, no cog, the old «N명» line', async () => {
    stubFetch(false); await mount();
    expect(q('room-head-tag')?.textContent).not.toBe('채널');
    expect(q('room-head-channel-settings')).toBeNull();
    expect(q('room-head-subline')?.textContent ?? '').not.toContain('부를 수 있는 에이전트');
  });
});
