// @vitest-environment jsdom
//
// story #3638(유나 디자인 CHANGES 2026-09-07) — 초기 로드(fetchMessages, no `before`)
// 실패가 messages를 빈 배열로 남겨 "대화를 시작하세요"를 그렸다 — 메시지가 있는
// 대화를 "없다"고 말하는 §1 클래스(모름을 없음으로 오독). ConnectionLostBanner는
// handlePoll 경로 하나만 덮어(SSE 끊김에서만 뜸) 이 자리를 못 막는다.
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

function stubFetch(messagesOk: boolean) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (typeof url === 'string' && url.includes('/messages?')) {
      return messagesOk
        ? { ok: true, json: async () => ({ data: [], meta: { next_cursor: null, has_more: false } }) }
        : { ok: false, json: async () => ({}) };
    }
    return { ok: true, json: async () => ({ data: [] }) };
  }));
}

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

describe('ChatView — 초기 로드 실패 시 문장(story #3638)', () => {
  it('초기 로드 실패 시 messagesLoadFailed 문구가 뜨고 "대화를 시작하세요"는 안 뜬다', async () => {
    stubFetch(false);
    await mount();
    expect(container.textContent).toContain(koMessages.chats.messagesLoadFailed);
    expect(container.textContent).not.toContain('대화를 시작하세요');
  });

  // 뮤테이션 대표 — 진짜 빈 대화(로드 성공, 메시지 0건)면 기존 empty state 그대로.
  it('진짜 빈 대화(로드 성공)면 "대화를 시작하세요"가 뜨고 messagesLoadFailed는 안 뜬다', async () => {
    stubFetch(true);
    await mount();
    expect(container.textContent).toContain('대화를 시작하세요');
    expect(container.textContent).not.toContain(koMessages.chats.messagesLoadFailed);
  });
});
