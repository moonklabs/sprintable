// @vitest-environment jsdom
//
// story #4444 — a failed block said «다시 시도해 주세요» whatever the cause, though retrying a refusal never works. The toast
// body now says the cause (Yuna 23:01Z): a network failure or a server error keeps «다시 시도해 주세요»; 404 (the person is
// no longer in this org) and any other refusal say so, with no retry promise. The title stays «차단 실패».
// Harness as chat-view.4430.test.tsx; the bubble is replaced by a button calling onBlockUser.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/chats/thread-1',
}));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('@/hooks/use-chat-sse', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-chat-sse')>();
  return { ...actual, useChatSse: () => ({ connected: true, polling: false }) };
});
vi.mock('./chat-bubble', () => ({
  ChatBubble: ({ message, onBlockUser }: { message: { id: string }; onBlockUser?: () => void }) => (
    onBlockUser ? <button type="button" data-testid={`block-${message.id}`} onClick={onBlockUser}>block</button> : null
  ),
}));
const { addToastMock } = vi.hoisted(() => ({ addToastMock: vi.fn() }));
vi.mock('@/components/ui/toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/toast')>();
  return { ...actual, useToast: () => ({ addToast: addToastMock }) };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  addToastMock.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } });
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
});

const THEIRS = { id: 'm1', thread_id: 'thread-1', sender: { id: 'them-1', name: '카디르', type: 'human' }, content: '안녕하세요', attachments: [], created_at: '2026-09-30T00:00:00.000Z' };

async function blockWith(answer: 'throw' | number) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string }) => {
    if (url === '/api/user-blocks' && init?.method === 'POST') {
      if (answer === 'throw') throw new TypeError('Failed to fetch');
      return { ok: false, status: answer, json: async () => ({}) };
    }
    if (typeof url === 'string' && url.includes('/messages?')) {
      return { ok: true, json: async () => ({ data: [THEIRS], meta: { next_cursor: null, has_more: false } }) };
    }
    return { ok: true, json: async () => ({ data: [] }) };
  }));
  const { ChatView } = await import('./chat-view');
  const { ChatRailProvider } = await import('../../app/(authenticated)/chats/chat-rail-context');
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <ChatRailProvider><ChatView threadId="thread-1" currentTeamMemberId="me-1" /></ChatRailProvider>
      </NextIntlClientProvider>,
    );
  });
  for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); });
  await act(async () => { (container.querySelector('[data-testid="block-m1"]') as HTMLElement).click(); });
  const confirm = [...document.body.querySelectorAll('button')].find((b) => b.textContent === '사용자 차단');
  await act(async () => { confirm!.click(); });
  for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve(); });
  expect(addToastMock).toHaveBeenCalledTimes(1);
  return addToastMock.mock.calls[0]![0] as { type: string; title: string; body?: string };
}

describe('ChatView — a failed block says why (#4444)', () => {
  it('network failure: «다시 시도해 주세요» (it may work next time)', async () => {
    const toast = await blockWith('throw');
    expect(toast).toMatchObject({ type: 'error', title: '차단 실패', body: '사용자를 차단하지 못했어요. 다시 시도해 주세요.' });
  });

  it('server error: the same retry line', async () => {
    expect((await blockWith(503)).body).toBe('사용자를 차단하지 못했어요. 다시 시도해 주세요.');
  });

  it('404: the person is no longer in this org — no retry promise', async () => {
    const toast = await blockWith(404);
    expect(toast).toMatchObject({ title: '차단 실패', body: '이 사용자는 이제 이 조직에 없어요.' });
  });

  it('any other refusal (400): «이 사용자는 차단할 수 없어요.»', async () => {
    const toast = await blockWith(400);
    expect(toast).toMatchObject({ title: '차단 실패', body: '이 사용자는 차단할 수 없어요.' });
  });
});
