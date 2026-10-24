// @vitest-environment jsdom
//
// story #4761 (D3) — the legacy chat view's send: the send answer's `agent_wake` puts the fact + what to do under my new bubble.
// Harness as chat-view.4311.test.tsx; ChatInput is replaced by a button calling onSend (the input's typing isn't watched here).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/chats/thread-1',
}));

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
}));

const { useChatSseMock } = vi.hoisted(() => ({
  useChatSseMock: vi.fn((_opts?: unknown) => ({ connected: true, polling: false })),
}));
vi.mock('@/hooks/use-chat-sse', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-chat-sse')>();
  return {
    ...actual,
    useChatSse: (opts: unknown) => useChatSseMock(opts),
  };
});

vi.mock('./chat-input', () => ({
  ChatInput: ({ onSend }: { onSend: (content: string) => Promise<void> | void }) => (
    <button type="button" data-testid="mock-send" onClick={() => { void onSend('내일 오전에 초안 공유할게요.'); }}>send</button>
  ),
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
  useChatSseMock.mockReturnValue({ connected: true, polling: false });
  Element.prototype.scrollIntoView = vi.fn(); // 메시지가 있으면 맨 아래로 스크롤한다(jsdom엔 없음).
  // 읽음 표시 · 무한 스크롤이 IntersectionObserver를 쓴다(jsdom엔 없음) — 관찰만 하는 빈 구현.
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } });
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function mount() {
  const { ChatView } = await import('./chat-view');
  const { ChatRailProvider } = await import('../../app/(authenticated)/chats/chat-rail-context');
  await act(async () => {
    root.render(wrap(
      <ChatRailProvider>
        <ChatView threadId="thread-1" currentTeamMemberId="me-1" />
      </ChatRailProvider>,
    ));
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

const SENT = {
  id: 'm9', thread_id: 'thread-1', sender: { id: 'me-1', name: '안나', type: 'human' }, content: '내일 오전에 초안 공유할게요.',
  attachments: [], created_at: '2026-10-23T23:30:16.640000+00:00',
};

function stubFetch(answer: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === 'POST' && typeof url === 'string' && url.endsWith('/thread-1/messages')) {
      return { ok: true, json: async () => answer };
    }
    if (typeof url === 'string' && url.includes('/messages?')) {
      return { ok: true, json: async () => ({ data: [], meta: { next_cursor: null, has_more: false } }) };
    }
    return { ok: true, json: async () => ({ data: [] }) };
  }));
}

async function send() {
  await mount();
  for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve(); });
  await act(async () => { (container.querySelector('[data-testid="mock-send"]') as HTMLElement).click(); });
  for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); });
}

describe('ChatView — story #4761 (D3) what to do when the agent cannot hear the message', () => {
  it('the send answer\'s `agent_wake` puts the fact, the sentence to say, and the app way under my new bubble', async () => {
    stubFetch({ data: SENT, agent_wake: { required: [{ member_id: 'ag-1', name: 'Walk Agent' }] } });
    await send();
    const notice = container.querySelector('[data-testid="agent-wake-notice"]');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain('이 에이전트(Walk Agent)는 새 메시지가 와도 스스로 알아채지 못해요');
    expect(notice?.textContent).toContain('“새 메시지 확인하고 답해 줘”');
    expect(notice?.textContent).toContain('Mac 앱을 쓰면 이 문장 없이도 새 메시지를 에이전트에게 넘겨요');
    expect(container.querySelector('[data-testid="agent-wake-app-link"]')?.getAttribute('href')).toContain('/desktop');
  });

  it('a view that is built after the send (fork · re-read) still draws the line the answer carried', async () => {
    // the send answered earlier in this tab (the memory the line is kept in is exercised by agent-wake.test.ts through the real send)
    const { rememberAgentWake } = await import('@/lib/chat/agent-wake');
    rememberAgentWake('m-forked', { required: [{ member_id: 'ag-1', name: 'Walk Agent' }] });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (typeof url === 'string' && url.includes('/messages?')) {
        return { ok: true, json: async () => ({ data: [{ ...SENT, id: 'm-forked' }], meta: { next_cursor: null, has_more: false } }) };
      }
      return { ok: true, json: async () => ({ data: [] }) };
    }));
    await mount();
    for (let i = 0; i < 8; i += 1) await act(async () => { await Promise.resolve(); });
    expect(container.querySelector('[data-testid="agent-wake-notice"]')?.textContent).toContain('이 에이전트(Walk Agent)');
  });

  it('no `agent_wake` in the answer → no line (an agent that hears the message needs none)', async () => {
    stubFetch({ data: SENT });
    await send();
    expect(container.querySelector('[data-testid="agent-wake-notice"]')).toBeNull();
  });

  it('an agent that answers in a thread needs no nudge line either (thread replies never enter the main list)', async () => {
    stubFetch({ data: SENT, agent_wake: { required: [{ member_id: 'ag-1', name: 'Walk Agent' }] } });
    await send();
    expect(container.querySelector('[data-testid="agent-wake-notice"]')).not.toBeNull();
    const opts = useChatSseMock.mock.calls.at(-1)?.[0] as { onConversationMessage?: (p: Record<string, unknown>) => void };
    await act(async () => {
      opts.onConversationMessage?.({
        id: 'm11', conversation_id: 'thread-1', thread_id: 'm9', parent_id: 'm9', sender: { id: 'ag-1', name: 'Walk Agent', type: 'agent' },
        content: '스레드로 답해요', attachments: [], created_at: '2026-10-23T23:32:14.410000+00:00',
      });
    });
    for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve(); });
    expect(container.querySelector('[data-testid="agent-wake-notice"]')).toBeNull();
  });

  it('what it remembers about thread answers is bounded (the newest 100) — an old answer\'s entry is let go after that many newer ones', async () => {
    stubFetch({ data: SENT, agent_wake: { required: [{ member_id: 'ag-1', name: 'Walk Agent' }] } });
    await send();
    const opts = useChatSseMock.mock.calls.at(-1)?.[0] as { onConversationMessage?: (p: Record<string, unknown>) => void };
    const reply = (id: string, parent: string) => opts.onConversationMessage?.({
      id, conversation_id: 'thread-1', thread_id: parent, parent_id: parent,
      sender: { id: 'ag-1', name: 'Walk Agent', type: 'agent' }, content: '답', attachments: [], created_at: '2026-10-23T23:32:14.410000+00:00',
    });
    await act(async () => { reply('r-first', 'm9'); }); // answered in my message's thread → the line ends
    for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve(); });
    expect(container.querySelector('[data-testid="agent-wake-notice"]')).toBeNull();
    await act(async () => { for (let i = 0; i < 100; i += 1) reply(`r-${i}`, `other-${i}`); }); // 100 newer answers elsewhere
    for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve(); });
    expect(container.querySelector('[data-testid="agent-wake-notice"]')).not.toBeNull(); // the first entry was let go of
  });

  it('a reply in ANOTHER message\'s thread does not hide the line', async () => {
    stubFetch({ data: SENT, agent_wake: { required: [{ member_id: 'ag-1', name: 'Walk Agent' }] } });
    await send();
    const opts = useChatSseMock.mock.calls.at(-1)?.[0] as { onConversationMessage?: (p: Record<string, unknown>) => void };
    await act(async () => {
      opts.onConversationMessage?.({
        id: 'm12', conversation_id: 'thread-1', thread_id: 'some-older-message', parent_id: 'some-older-message',
        sender: { id: 'ag-1', name: 'Walk Agent', type: 'agent' }, content: '다른 스레드', attachments: [], created_at: '2026-10-23T23:32:14.410000+00:00',
      });
    });
    for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve(); });
    expect(container.querySelector('[data-testid="agent-wake-notice"]')).not.toBeNull();
  });

  it('the line goes away when that agent says anything after my message', async () => {
    stubFetch({ data: SENT, agent_wake: { required: [{ member_id: 'ag-1', name: 'Walk Agent' }] } });
    await send();
    expect(container.querySelector('[data-testid="agent-wake-notice"]')).not.toBeNull();
    const opts = useChatSseMock.mock.calls.at(-1)?.[0] as { onConversationMessage?: (p: Record<string, unknown>) => void };
    await act(async () => {
      opts.onConversationMessage?.({
        id: 'm10', conversation_id: 'thread-1', sender: { id: 'ag-1', name: 'Walk Agent', type: 'agent' },
        content: '안녕하세요!', attachments: [], created_at: '2026-10-23T23:32:14.410000+00:00',
      });
    });
    for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve(); });
    expect(container.querySelector('[data-testid="agent-wake-notice"]')).toBeNull();
  });
});
