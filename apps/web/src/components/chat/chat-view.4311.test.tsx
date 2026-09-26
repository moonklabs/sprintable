// @vitest-environment jsdom
//
// [SID:4311 PR 3] 대화 화면 발신자 — 같은 이름 서로 다른 발신자 둘이면 «· ID 앞 8자»(발신자 id마다 한 번 · 불러온 메시지 안에서만) ·
// 내 메시지는 «나»라 셈에서 뺀다. 하네스는 chat-view.load-fail.test.tsx와 같다.
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

// story #3638(유나 재판정 CHANGES) — fetch 자체가 던지는 표본(오프라인·DNS 등, !res.ok
// 분기를 아예 안 거친다). stubFetch(false)는 {ok:false}를 정상 반환해 이 표본을 못 잡는다.
function stubFetchThrows() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (typeof url === 'string' && url.includes('/messages?')) {
      throw new Error('network down');
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

describe('ChatView — 발신자 동명이인([SID:4311 PR 3])', () => {
  it('«송윤재» 둘 = 말풍선마다 id 앞 8자 · 같은 사람 두 말풍선 = 같은 꼬리 · 나와 같은 이름의 남 = 꼬리 없음', async () => {
    const msg = (id: string, sid: string, name: string, at: string) => ({
      id, thread_id: 'thread-1', created_by: sid, sender: { id: sid, name, type: 'human' }, content: `본문 ${id}`, attachments: [], created_at: at,
    });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (typeof url === 'string' && url.includes('/messages?')) {
        return { ok: true, json: async () => ({ data: [
          msg('m1', 'e75ca548-1', '송윤재', '2026-09-25T00:01:00.000Z'),
          msg('m2', '2fd14616-2', '송윤재', '2026-09-25T00:02:00.000Z'),
          msg('m3', 'e75ca548-1', '송윤재', '2026-09-25T00:03:00.000Z'),
          msg('m4', 'me-1', '안나', '2026-09-25T00:04:00.000Z'),
          msg('m5', 'other-anna', '안나', '2026-09-25T00:05:00.000Z'),
        ], meta: { next_cursor: null, has_more: false } }) };
      }
      return { ok: true, json: async () => ({ data: [] }) };
    }));
    await mount();
    for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve(); });
    const names = [...container.querySelectorAll('span.text-\\[11px\\].font-medium')].map((el) => el.textContent).filter((n) => n !== koMessages.chats.you);
    expect([...names].sort()).toEqual(['송윤재 · 2fd14616', '송윤재 · e75ca548', '송윤재 · e75ca548', '안나'].sort());
  });
});
