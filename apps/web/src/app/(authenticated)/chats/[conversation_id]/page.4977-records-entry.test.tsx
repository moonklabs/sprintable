// @vitest-environment jsdom
//
// story 4977 (B3-3) — the room head's «⋯» menu has «기록» for a chat with an agent, also when no session runs: only in the phone app, only where THIS shell says it opens records (`shell.caps`),
// never in a browser (which never asks the shell), never for a group or a person.
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

const params = vi.hoisted(() => ({ id: 'conv-1' }));
vi.mock('next/navigation', () => ({
  useParams: () => ({ conversation_id: params.id }),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));

vi.mock('@/components/chat/chat-view', () => ({
  ChatView: () => <div data-testid="chat-view-stub" />,
}));

vi.mock('@/hooks/use-synthetic-parent-tab-history', () => ({
  useSyntheticParentTabHistory: () => {},
}));

const bridge = vi.hoisted(() => ({ inPhoneApp: true, phoneCall: vi.fn() }));
vi.mock('@/components/providers/phone-bridge-context', () => ({ usePhoneBridge: () => bridge }));
const sheetProps = vi.hoisted(() => ({ last: null as null | Record<string, unknown> }));
vi.mock('@/components/chat/agent-records-sheet', () => ({
  AgentRecordsSheet: (p: Record<string, unknown>) => { sheetProps.last = p; return p.open ? <div data-testid="records-sheet-stub" /> : null; },
}));
vi.mock('@/components/chat/agent-session-strip', () => ({ AgentSessionStrip: () => null }));

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

const caps = (records: unknown) => bridge.phoneCall.mockImplementation(async (type: string) => (type === 'shell.caps' ? { id: 'c', ok: true, caps: records === undefined ? {} : { records } } : { id: 'c', ok: false, code: 'bad_request' }));
const capsCalls = () => bridge.phoneCall.mock.calls.filter((c) => c[0] === 'shell.caps').length;

beforeEach(() => {
  bridge.inPhoneApp = true; bridge.phoneCall.mockReset(); sheetProps.last = null; caps(1); params.id = 'conv-1';
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

function stubFetch(them: 'agent' | 'human' = 'agent', type: 'dm' | 'group' = 'dm') {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (/\/api\/conversations\/conv-[12]/.test(url)) {
      return {
        ok: true,
        json: async () => ({
          title: type === 'group' ? '팀 채널' : null, type, muted: false, last_read_at: null, free_response: false,
          participants: [
            { member_id: 'me-1', name: '나', avatar_url: null, type: 'human' },
            { member_id: 'them-1', name: '유나', avatar_url: null, type: them },
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
  const tree = () => wrap(
    <ToastProvider>
      <TopBarProvider>
        <TopBarRenderer />
        <ConversationPage />
      </TopBarProvider>
      <TestToastRenderer />
    </ToastProvider>,
  );
  rerender = async () => { await act(async () => { root.render(tree()); }); await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }); };
  await rerender();
}
let rerender: () => Promise<void> = async () => {};


const triggerOf = () => container.querySelector('[data-testid="room-head-menu"]') as HTMLElement | null;
async function openMenu() {
  await act(async () => { triggerOf()!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); triggerOf()!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  // The popup opens in a first frame marked `data-starting-style` (the library's opening transition). An item pressed INSIDE that frame is dropped: the item's own handler runs, the library's close does not — the settings test then saw the window open and the menu still open, in 6 whole-file runs of 6 on a fast machine (0 of 6 once the click came 100 ms later; a person cannot press an item in the first frame). Wait for the popup to have left that frame — a state, not a time.
  await vi.waitFor(() => {
    const popup = document.querySelector('[role=menu]');
    expect(popup, 'the menu popup is there').not.toBeNull();
    expect(popup!.hasAttribute('data-starting-style'), 'the popup has left its opening frame').toBe(false);
  });
}

const recordsItem = () => document.querySelector('[data-testid="room-head-records"]') as HTMLElement | null;
const ko = koMessages.chats.agentSession.records;

describe('ConversationPage — «기록» in the room head menu (story 4977 · B3-3)', () => {
  it('⭐ a chat with an agent in the phone app, a shell that says `records: 1`: the menu has «기록» (before the room settings), and it opens the sheet for THIS room with no computer named', async () => {
    stubFetch('agent'); await mount();
    await openMenu();
    const item = recordsItem();
    expect(item, 'the item').not.toBeNull();
    expect(item!.textContent).toBe(ko.button);
    const settings = document.querySelector('[data-testid="room-head-settings"]')!;
    expect(item!.compareDocumentPosition(settings) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.querySelector('[data-testid="records-sheet-stub"]')).toBeNull(); // not opened by itself
    await act(async () => { item!.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(document.querySelector('[data-testid="records-sheet-stub"]')).not.toBeNull();
    expect(sheetProps.last).toMatchObject({ conversationId: 'conv-1', setupId: null, agentId: 'them-1', open: true });
    expect(capsCalls()).toBe(1); // asked once
  });

  it('no item: the browser (and it never asks the shell) · an older shell (no `records`, 0, 2, a word) · a group · a person', async () => {
    stubFetch('agent'); bridge.inPhoneApp = false;
    await mount(); await openMenu();
    expect(recordsItem()).toBeNull();
    expect(capsCalls()).toBe(0);
    for (const records of [undefined, 0, 2, true, '1']) {
      await act(async () => { root.unmount(); }); root = createRoot(container);
      bridge.inPhoneApp = true; caps(records); stubFetch('agent');
      await mount(); await openMenu();
      expect(recordsItem(), String(records)).toBeNull();
    }
    for (const [them, type] of [['agent', 'group'], ['human', 'dm']] as const) {
      await act(async () => { root.unmount(); }); root = createRoot(container);
      bridge.phoneCall.mockClear(); caps(1); stubFetch(them, type);
      await mount(); await openMenu();
      expect(recordsItem(), `${them}/${type}`).toBeNull();
      expect(capsCalls(), `${them}/${type}`).toBe(0); // no place for it: the shell is not asked
    }
  });

  it('⭐ a cold load where the person\'s own member id is still on its way: the page renders its «wait» row first and the menu after — the hook order never changes (reverted: React throws)', async () => {
    stubFetch('agent');
    let calls = 0;
    useDashboardContextMock.mockImplementation(() => ({ currentTeamMemberId: calls++ < 2 ? null : 'me-1', projectId: 'proj-content', projectMemberships: [] }));
    await mount();
    await rerender(); await rerender();
    await openMenu();
    expect(recordsItem()).not.toBeNull();
  });

  it('a page reused for another room does not open that room\'s sheet by itself', async () => {
    stubFetch('agent'); await mount();
    await openMenu();
    await act(async () => { recordsItem()!.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(sheetProps.last).toMatchObject({ conversationId: 'conv-1', open: true });
    params.id = 'conv-2';
    await rerender();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(sheetProps.last).toMatchObject({ conversationId: 'conv-2', open: false }); // (a bare flag would still be true here)
  });
});
