// @vitest-environment jsdom
//
// story #4442 — the tab that sent a message updates its own conversation list row from the send answer (its own echo is
// dropped since #4440, so the list never heard of it): the row goes to the top with the new line and time, unread +0.
// An attachment-only message reads «첨부 파일» (Yuna) — right after sending and after a reload alike; «메시지 없음» only
// when there is truly no message.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ChatListView } from './chat-list-view';

vi.mock('@/hooks/use-auto-refresh', () => ({ useAutoRefresh: () => {} }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ({ role: 'member' }) }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));
const { useChatSseMock } = vi.hoisted(() => ({ useChatSseMock: vi.fn((_opts?: unknown) => ({ connected: true, polling: false })) }));
vi.mock('@/hooks/use-chat-sse', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/use-chat-sse')>('@/hooks/use-chat-sse');
  return { ...actual, useChatSse: (opts: unknown) => useChatSseMock(opts) };
});
vi.mock('@/components/realtime-provider', () => ({
  useSseMultiplexerContext: () => ({ isAlive: () => false, subscribe: () => () => {}, subscribeMessage: () => () => {}, subscribeReconnect: () => () => {}, connected: true }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const ME = 'me-1';
const conv = (id: string, title: string, latest: Record<string, unknown> | null, updated: string) => ({
  id, type: 'group', title, participants: [], unread_count: 0, latest_message: latest, updated_at: updated, created_at: updated,
});

function stub(rows: unknown[]) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/api/conversations/recent-outside-project')) return { ok: true, json: async () => ({ data: [] }) };
    if (url.includes('/api/conversations?')) return { ok: true, json: async () => ({ data: rows, total: rows.length }) };
    return { ok: false, status: 404, json: async () => null };
  }));
}

async function mount() {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <ChatListView projectId="proj-1" currentTeamMemberId={ME} />
      </NextIntlClientProvider>,
    );
  });
  for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve(); });
}

const latestOpts = () => [...useChatSseMock.mock.calls].reverse().map((c) => c[0] as Record<string, unknown>)
  .find((o) => 'onSentHere' in o) as { onSentHere?: (p: Record<string, unknown>) => void } | undefined;
const rowTexts = () => [...container.querySelectorAll('button, a, li')].map((el) => el.textContent ?? '')
  .filter((t) => /회의방|기획방|새 그룹방/.test(t));

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useChatSseMock.mockClear();
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

describe('ChatListView — the sending tab\'s own row (#4442)', () => {
  it('a send from this tab moves its row to the top with the new line; no unread', async () => {
    stub([
      conv('c-1', '회의방', { content: '먼저 온 말', created_at: '2026-10-01T00:10:00Z' }, '2026-10-01T00:10:00Z'),
      conv('c-2', '기획방', { content: '오래된 말', created_at: '2026-10-01T00:00:00Z' }, '2026-10-01T00:00:00Z'),
    ]);
    await mount();
    expect(rowTexts()[0]).toContain('회의방');
    await act(async () => {
      latestOpts()?.onSentHere?.({ id: 'm-9', conversation_id: 'c-2', content: '방금 보낸 말', created_at: '2026-10-01T00:20:00Z', sender: { id: ME } });
    });
    const rows = rowTexts();
    expect(rows[0]).toContain('기획방');
    expect(rows[0]).toContain('방금 보낸 말');
    expect(container.textContent).not.toMatch(/기획방[^회]*\b1\b/); // no unread badge count for my own message
  });

  it('an attachment-only send reads «첨부 파일», and so does a row that loads with one', async () => {
    stub([
      conv('c-1', '회의방', { content: '', created_at: '2026-10-01T00:10:00Z', has_attachments: true }, '2026-10-01T00:10:00Z'),
      conv('c-2', '기획방', { content: '오래된 말', created_at: '2026-10-01T00:00:00Z' }, '2026-10-01T00:00:00Z'),
    ]);
    await mount();
    expect(rowTexts()[0]).toContain('첨부 파일'); // after a reload
    expect(rowTexts()[0]).not.toContain('메시지 없음');
    await act(async () => {
      latestOpts()?.onSentHere?.({ id: 'm-10', conversation_id: 'c-2', content: '', attachments: [{ url: 'x', name: 'a.png' }], created_at: '2026-10-01T00:30:00Z', sender: { id: ME } });
    });
    expect(rowTexts()[0]).toContain('기획방');
    expect(rowTexts()[0]).toContain('첨부 파일'); // right after sending
  });
  // PO 23:25Z (Qadir's two line-2 findings, one root) — a send to a conversation the list doesn't hold yet (a DM that
  // branched into a new group · a conversation opened by link, outside the first page) must read the list again, as a
  // received message does (`applyConversationMessageUpdate`'s «unknown → refetch»). The legacy list already goes through
  // it; this pins it for the send path.
  it('a send to a conversation not in the list reads the list again — its row comes up top', async () => {
    let rows: unknown[] = [
      conv('c-1', '회의방', { content: '먼저 온 말', created_at: '2026-10-01T00:10:00Z' }, '2026-10-01T00:10:00Z'),
    ];
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/api/conversations/recent-outside-project')) return { ok: true, json: async () => ({ data: [] }) };
      if (url.includes('/api/conversations?')) return { ok: true, json: async () => ({ data: rows, total: rows.length }) };
      return { ok: false, status: 404, json: async () => null };
    });
    vi.stubGlobal('fetch', fetchMock);
    await mount();
    const listReads = () => fetchMock.mock.calls.filter((c) => String(c[0]).includes('/api/conversations?')).length;
    const before = listReads();
    rows = [conv('c-new', '새 그룹방', { content: '갈라져 나온 첫 말', created_at: '2026-10-01T00:40:00Z' }, '2026-10-01T00:40:00Z'), ...rows];
    await act(async () => {
      latestOpts()?.onSentHere?.({ id: 'm-11', conversation_id: 'c-new', content: '갈라져 나온 첫 말', created_at: '2026-10-01T00:40:00Z', sender: { id: ME } });
    });
    for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve(); });
    expect(listReads()).toBeGreaterThan(before);
    expect(rowTexts()[0]).toContain('새 그룹방');
    expect(rowTexts()[0]).toContain('갈라져 나온 첫 말');
  });
});
