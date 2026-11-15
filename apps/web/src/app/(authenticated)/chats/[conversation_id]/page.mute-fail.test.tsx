// @vitest-environment jsdom
//
// story #3638(유나 §8 별건) — handleToggleMute가 실패해도 조용히 원복되던 자리
// (§2 클래스). muteToggleFailed 신규 1키.
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

function stubFetch(muteOk: boolean) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/api/conversations/conv-1/mute')) {
      return { ok: muteOk, json: async () => ({}) };
    }
    if (url.includes('/api/conversations/conv-1')) {
      return {
        ok: true,
        json: async () => ({
          title: null, type: 'dm', muted: false, lastReadAt: null, freeResponse: false,
          participants: [
            { member_id: 'me-1', name: '나', avatar_url: null, type: 'human' },
            { member_id: 'them-1', name: '유나', avatar_url: null, type: 'human' },
          ],
        }),
      };
    }
    return { ok: true, json: async () => ({ data: [] }) };
  }));
}

// story #3759 — ConversationPage가 useToast()로 공유 Context를 구독한다. afterEach의
// vi.resetModules() 때문에 «같은» 새로 뜬 @/components/ui/toast 인스턴스를 함께 동적
// import한다(kanban-board.test.tsx와 동형 처방).
async function mount() {
  const { default: ConversationPage } = await import('./page');
  const { TopBarProvider, useTopBar } = await import('@/components/nav/top-bar-context');
  const { ToastProvider, ToastContainer, useToast } = await import('@/components/ui/toast');
  function TopBarRenderer() {
    const { title, actions } = useTopBar();
    return <div>{title}{actions}</div>;
  }
  function TestToastRenderer() {
    const { toasts, dismissToast } = useToast();
    return <ToastContainer toasts={toasts} onDismiss={dismissToast} />;
  }
  await act(async () => {
    root.render(wrap(
      <ToastProvider>
        <TopBarProvider>
          <TopBarRenderer />
          <ConversationPage />
        </TopBarProvider>
        <TestToastRenderer />
      </ToastProvider>,
    ));
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

// story 4887 (UI-4 P3-a) — mute and notification settings live in the room head's «⋯» menu now: open it, then take the item
async function openHeadMenuItem(testId: string): Promise<HTMLElement> {
  const trigger = container.querySelector('[data-testid="room-head-menu"]') as HTMLElement | null;
  expect(trigger, 'the room head «⋯» menu').not.toBeNull();
  await act(async () => { trigger!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); trigger!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  // Wait for STATE, not for a fixed number of ticks: the popup mounts after the click, and opens in a first frame (`data-starting-style`) in which a pressed item is dropped by the library.
  // (Two flushes and one lookup passed on a quiet machine and failed 3 runs of 5 under load: «the ⋯ menu item room-head-mute: expected null not to be null» — the same race page.4887-head-menu.test.tsx's openMenu() already waits out.)
  await vi.waitFor(() => {
    const popup = document.querySelector('[role=menu]');
    expect(popup, 'the menu popup is there').not.toBeNull();
    expect(popup!.hasAttribute('data-starting-style'), 'the popup has left its opening frame').toBe(false);
    expect(document.querySelector(`[data-testid="${testId}"]`), `the «⋯» menu item ${testId}`).not.toBeNull();
  });
  return document.querySelector(`[data-testid="${testId}"]`) as HTMLElement;
}

describe('ConversationPage — 뮤트 토글 실패 시 문장(story #3638)', () => {
  it('mute PATCH 실패 시 muteToggleFailed 토스트가 뜬다(구 조용한 롤백)', async () => {
    stubFetch(false);
    await mount();
    const muteItem = await openHeadMenuItem('room-head-mute');
    expect(muteItem.textContent).toContain('알림 끄기');
    await act(async () => { muteItem.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain(koMessages.chats.muteToggleFailed);
  });

  // 뮤테이션 대표 — 성공 시엔 토스트가 안 뜨고 버튼이 "알림 켜기"(뮤트 상태)로 바뀐다.
  it('mute PATCH 성공 시엔 토스트가 안 뜨고 상태가 실제로 바뀐다', async () => {
    stubFetch(true);
    await mount();
    const muteItem = await openHeadMenuItem('room-head-mute');
    expect(muteItem.textContent).toContain('알림 끄기');
    await act(async () => { muteItem.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).not.toContain(koMessages.chats.muteToggleFailed);
    expect(container.querySelector('[data-testid="room-muted-indicator"]')).not.toBeNull(); // the muted STATE is visible without opening anything
    expect((await openHeadMenuItem('room-head-mute')).textContent).toContain('알림 켜기'); // and the menu now offers the way back
  });
});
