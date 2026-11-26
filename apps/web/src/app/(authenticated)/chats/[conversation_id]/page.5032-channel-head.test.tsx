// @vitest-environment jsdom
//
// story 5032 (C2) — a project channel's room head: the tag «채널», the line «사람 N · 부를 수 있는 에이전트 N», and a named settings cog that opens the delivery dialog; a one-to-one / group room has none of these.
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

  it('⭐ the cog opens the delivery dialog (the channel\'s «who gets every word» settings)', async () => {
    stubFetch(true); await mount();
    await act(async () => { q('room-head-channel-settings')!.click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(document.body.textContent).toContain(koMessages.chats.deliveryContractTitle);
  });

  it('⭐ the delivery dialog the cog opened gives focus back to the cog (not to the «⋯» menu)', async () => {
    stubFetch(true); await mount();
    const cog = q('room-head-channel-settings') as HTMLButtonElement;
    await act(async () => { cog.focus(); cog.click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(document.body.textContent).toContain(koMessages.chats.deliveryContractTitle);
    const closeBtn = [...document.querySelectorAll('button')].find((b) => /닫기|취소/.test(b.textContent ?? '')) as HTMLButtonElement | undefined;
    expect(closeBtn, 'the dialog has a close/cancel button').toBeTruthy();
    await act(async () => { closeBtn!.click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(document.activeElement === cog, 'focus is back on the cog').toBe(true);
  });

  it('⭐ a one-to-one / group room keeps its own head: no channel tag, no cog, the old «N명» line', async () => {
    stubFetch(false); await mount();
    expect(q('room-head-tag')?.textContent).not.toBe('채널');
    expect(q('room-head-channel-settings')).toBeNull();
    expect(q('room-head-subline')?.textContent ?? '').not.toContain('부를 수 있는 에이전트');
  });
});
