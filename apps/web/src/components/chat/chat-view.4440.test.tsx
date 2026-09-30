// @vitest-environment jsdom
//
// story #4440 — the legacy chat view with the real SSE hook: my message sent from another tab or device appears here live,
// and a reply sent there bumps the parent's reply count once; a reply this tab sent (its own echo) does not bump it again.
// Harness as chat-view.4311.test.tsx, except useChatSse is real (a fake EventSource stands in for the stream).
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

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];
  listeners: Record<string, Array<(e: { data: string; lastEventId?: string }) => void>> = {};
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  readyState = 1;
  constructor(public url: string) { FakeEventSource.instances.push(this); }
  addEventListener(type: string, cb: (e: { data: string; lastEventId?: string }) => void) { (this.listeners[type] ??= []).push(cb); }
  close() { /* noop */ }
  emit(type: string, data: unknown) { for (const cb of this.listeners[type] ?? []) cb({ data: JSON.stringify(data) }); }
}

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
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
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

const parent = {
  id: 'm1', thread_id: 'thread-1', created_by: 'other-1', sender: { id: 'other-1', name: '민아', type: 'human' },
  content: '회의록 봐 주세요', attachments: [], created_at: '2026-09-30T20:00:00.000Z', reply_count: 0,
};
const replyOf = (id: string, extra: Record<string, unknown> = {}) => ({
  id, conversation_id: 'thread-1', thread_id: 'm1', created_by: 'me-1', sender: { id: 'me-1', name: '안나', type: 'human' },
  content: `답글 ${id}`, attachments: [], created_at: '2026-09-30T20:01:00.000Z', ...extra,
});

function stubReads() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (typeof url === 'string' && url.includes('/messages?')) {
      return { ok: true, json: async () => ({ data: [parent], meta: { next_cursor: null, has_more: false } }) };
    }
    return { ok: true, json: async () => ({ data: [] }) };
  }));
}

async function settle() {
  for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); });
}

const replyCountText = () => [...container.querySelectorAll('button, span')].map((el) => el.textContent ?? '').find((t) => /개의 답글/.test(t)) ?? null;

describe('ChatView — my message from another tab (#4440)', () => {
  it('a reply sent from another tab bumps the parent\'s reply count once', async () => {
    stubReads();
    await mount();
    await settle();
    const es = FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
    await act(async () => { es.emit('conversation.message_created', replyOf('r-other', { client_nonce: 'from-the-desktop-app' })); });
    await settle();
    expect(replyCountText()).toContain('1개의 답글');
  });

  it('this tab\'s own reply echo (its nonce) does not bump it again', async () => {
    const { newClientNonce } = await import('@/hooks/use-chat-sse');
    stubReads();
    await mount();
    await settle();
    const es = FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
    const nonce = newClientNonce(); // as the thread panel does before it sends (it bumps the count itself)
    await act(async () => { es.emit('conversation.message_created', replyOf('r-here', { client_nonce: nonce })); });
    await settle();
    expect(replyCountText()).toBeNull(); // still 0 here — the sending path counted it, not the echo
  });
});
