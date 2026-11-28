// @vitest-environment jsdom
//
// story 5031 (C1) — /chats/<id> on a phone: when the room's FIRST read of its messages fails, the room said «대화를 불러오지 못했어요.» and offered NO way to ask again:
// the auto-poll runs only while the live link is down (useChatSse `polling`), the connection banner shows only then too, and the pull-down is a hidden gesture. With the live link UP (the read
// fails, the link does not) a finger had a sentence and nothing to press. The failed read now draws the ds ErrorState with «다시 시도». (boilerplate as chat-view.load-fail.test.tsx)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/chats/thread-1',
}));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => true }));

const { useChatSseMock } = vi.hoisted(() => ({
  useChatSseMock: vi.fn((_opts?: unknown) => ({ connected: true, polling: false })),
}));
vi.mock('@/hooks/use-chat-sse', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-chat-sse')>();
  return { ...actual, useChatSse: (opts: unknown) => useChatSseMock(opts) };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let messageReads: number;
let messagesAnswer: () => unknown;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  messageReads = 0;
  useChatSseMock.mockReturnValue({ connected: true, polling: false }); // the live link is UP: nothing else will ask again
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (typeof url === 'string' && url.includes('/messages?')) { messageReads += 1; return messagesAnswer() as never; }
    return { ok: true, json: async () => ({ data: [] }) };
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
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <ChatRailProvider><ChatView threadId="thread-1" currentTeamMemberId="me-1" /></ChatRailProvider>
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });
}
const retry = () => [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === koMessages.common.retry) as HTMLButtonElement | undefined;
const failing = () => ({ ok: false, json: async () => ({}) });

describe('[SID:5031] ChatView — a failed first read of the messages has a retry a finger can press', () => {
  it('⭐the failure sentence comes with a «다시 시도» button (live link up)', async () => {
    messagesAnswer = failing;
    await mount();
    expect(container.textContent).toContain(koMessages.chats.messagesLoadFailed);
    expect(retry()).toBeDefined(); // reverted → only the sentence
  });

  it('⭐pressing it reads the messages again: the failure goes (a real empty room says «대화를 시작하세요»)', async () => {
    messagesAnswer = failing;
    await mount();
    expect(messageReads).toBe(1);
    messagesAnswer = () => ({ ok: true, json: async () => ({ data: [], meta: { next_cursor: null, has_more: false } }) });
    await act(async () => { retry()!.click(); });
    await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });
    expect(messageReads).toBe(2);
    expect(container.textContent).not.toContain(koMessages.chats.messagesLoadFailed);
    expect(container.textContent).toContain(koMessages.chats.messagesEmptyTitle);
  });

  it('⭐a retry that fails again keeps the failure with its retry (never «대화를 시작하세요»)', async () => {
    messagesAnswer = failing;
    await mount();
    await act(async () => { retry()!.click(); });
    await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });
    expect(messageReads).toBe(2);
    expect(container.textContent).toContain(koMessages.chats.messagesLoadFailed);
    expect(container.textContent).not.toContain(koMessages.chats.messagesEmptyTitle);
    expect(retry()).toBeDefined();
  });

  // codex 1 (HIGH): «다시 시도» can overlap a read that was already in flight (a reconnect / poll). Only the NEWEST read of the latest messages may say «failed» or end the loading.
  type Answer = { ok: boolean; json: () => Promise<unknown> };
  const okEmpty = (): Answer => ({ ok: true, json: async () => ({ data: [], meta: { next_cursor: null, has_more: false } }) });
  const fail500 = (): Answer => ({ ok: false, json: async () => ({}) });
  function deferredAnswer() {
    let release: (a: Answer) => void = () => {};
    const promise = new Promise<Answer>((resolve) => { release = resolve; });
    return { promise, release };
  }
  const settle = async () => { await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); }); };
  const pollNow = async () => {
    const opts = useChatSseMock.mock.calls[useChatSseMock.mock.calls.length - 1][0] as { onPoll: () => Promise<boolean> };
    await act(async () => { void opts.onPoll(); });
  };

  it('⭐① a poll that was already in flight answers 500 AFTER the retry has succeeded: the failure does not come back', async () => {
    const poll = deferredAnswer();
    const plan: Array<() => unknown> = [fail500, () => poll.promise, okEmpty]; // initial · poll (in flight) · retry
    messagesAnswer = () => plan[messageReads - 1]!();
    await mount();
    await pollNow(); // read 2 is now in flight
    expect(messageReads).toBe(2);
    await act(async () => { retry()!.click(); }); // read 3 (the retry) succeeds with an empty room
    await settle();
    expect(container.textContent).toContain(koMessages.chats.messagesEmptyTitle);
    await act(async () => { poll.release(fail500()); }); // the OLD read answers late, with a 500
    await settle();
    expect(container.textContent).not.toContain(koMessages.chats.messagesLoadFailed); // reverted (no ticket) → the failure comes back over a good answer
    expect(container.textContent).toContain(koMessages.chats.messagesEmptyTitle);
  });

  it('② the OLD read succeeds and the NEWEST (the retry) fails: the failure stands, and the old answer does not end the retry\'s loading early', async () => {
    const poll = deferredAnswer();
    const retried = deferredAnswer();
    const plan: Array<() => unknown> = [fail500, () => poll.promise, () => retried.promise];
    messagesAnswer = () => plan[messageReads - 1]!();
    await mount();
    await pollNow();
    await act(async () => { retry()!.click(); });
    await settle();
    expect(container.textContent).toContain(koMessages.common.loading);
    expect(container.querySelector('[role="status"]')?.textContent).toContain(koMessages.common.loading); // the removed button leaves a spoken «불러오는 중…»
    await act(async () => { poll.release(okEmpty()); }); // the old one answers first, fine
    await settle();
    expect(container.textContent).not.toContain(koMessages.chats.messagesEmptyTitle); // the newest read is still out: still loading (reverted → the old read ended the loading)
    await act(async () => { retried.release(fail500()); });
    await settle();
    expect(container.textContent).toContain(koMessages.chats.messagesLoadFailed);
    expect(retry()).toBeDefined();
  });
});
