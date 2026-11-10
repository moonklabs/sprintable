// @vitest-environment jsdom
//
// story 4887 (UI-4 P4-a) — the room body groups messages into runs: the SAME sender with no gap over five minutes between neighbours. Only the first message of a run draws the head (name · time); the rest continue it.
// The real ChatView and ChatBubble on a fed message list; the rule itself is pinned in timeline-grouping.test.ts — this proves the screen USES it (it was «same sender, any gap»). Harness as chat-view.4847.test.tsx.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/chats/thread-1' }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('@/hooks/use-chat-sse', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-chat-sse')>();
  return { ...actual, useChatSse: () => ({ connected: true, polling: false }) };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } });
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); vi.resetModules(); });

const msg = (id: string, by: string, at: string) => ({
  id, memo_id: 'thread-1', created_by: by, sender_name: by === 'a-1' ? '개발 에이전트' : '검수 에이전트', sender_type: 'agent', sender_avatar_url: null, sender_runtime_type: null,
  content: `글 ${id}`, attachments: [], created_at: at, reply_count: 0,
});
const at = (min: number) => new Date(Date.UTC(2026, 10, 10, 1, min, 0)).toISOString(); // 10:00 + min in Seoul — one day

async function mountWith(messages: object[]) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (typeof url === 'string' && url.includes('/messages?')) return { ok: true, json: async () => ({ data: messages, meta: { next_cursor: null, has_more: false } }) };
    return { ok: true, status: 200, json: async () => ({ data: [] }) };
  }));
  const { ChatView } = await import('./chat-view');
  const { ChatRailProvider } = await import('../../app/(authenticated)/chats/chat-rail-context');
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><ChatRailProvider><ChatView threadId="thread-1" currentTeamMemberId="me-1" projectId={undefined} /></ChatRailProvider></NextIntlClientProvider>);
  });
  for (let i = 0; i < 10; i += 1) await act(async () => { await Promise.resolve(); });
}
const heads = () => [...container.querySelectorAll('[data-testid="bubble-head-time"]')];
const rows = () => [...container.querySelectorAll('.group\\/bubble')];

describe('ChatView — runs of one sender (story 4887 · UI-4 P4-a)', () => {
  it('⭐ the same sender within five minutes is ONE run (one head); the same sender six minutes later starts a new one; another sender starts one', async () => {
    await mountWith([msg('m1', 'a-1', at(0)), msg('m2', 'a-1', at(3)), msg('m3', 'a-1', at(9)), msg('m4', 'b-1', at(10))]);
    expect(rows()).toHaveLength(4);
    expect(heads()).toHaveLength(3); // m1 · m3 (a 6-minute gap) · m4 (another sender) — reverted (same sender, any gap) → 2
    expect(heads().map((h) => h.closest('.group\\/bubble')!.textContent)).toEqual([expect.stringContaining('글 m1'), expect.stringContaining('글 m3'), expect.stringContaining('글 m4')]);
  });

  it('a chat of one sender whose messages keep coming within five minutes of each other stays ONE run however long it lasts', async () => {
    await mountWith([0, 4, 8, 12, 16].map((m, i) => msg(`m${i}`, 'a-1', at(m))));
    expect(rows()).toHaveLength(5);
    expect(heads()).toHaveLength(1);
  });
});
