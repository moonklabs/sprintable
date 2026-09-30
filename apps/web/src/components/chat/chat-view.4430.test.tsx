// @vitest-environment jsdom
//
// story #4430 — the legacy chat view's send: the send answer's `delivery` puts «not delivered» under my new bubble.
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

describe('ChatView — story #4430 «not delivered» under my new bubble', () => {
  it('the send answer\'s `delivery` lands on my new message', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string }) => {
      if (init?.method === 'POST' && typeof url === 'string' && url.endsWith('/thread-1/messages')) {
        return {
          ok: true,
          json: async () => ({
            data: { id: 'm9', thread_id: 'thread-1', sender: { id: 'me-1', name: '안나', type: 'human' }, content: '내일 오전에 초안 공유할게요.', attachments: [], created_at: '2026-09-25T00:09:00.000Z' },
            delivery: { withheld_count: 1, reason: 'recipient_blocked_sender', conversation_type: 'dm' },
          }),
        };
      }
      if (typeof url === 'string' && url.includes('/messages?')) {
        return { ok: true, json: async () => ({ data: [], meta: { next_cursor: null, has_more: false } }) };
      }
      return { ok: true, json: async () => ({ data: [] }) };
    }));
    await mount();
    for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve(); });
    await act(async () => { (container.querySelector('[data-testid="mock-send"]') as HTMLElement).click(); });
    for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); });
    expect(container.querySelector('[data-testid="withheld-delivery-line"]')?.textContent)
      .toBe('전달되지 않았어요 — 받는 사람이 내 메시지를 받지 않도록 해 두었어요');
  });
});
