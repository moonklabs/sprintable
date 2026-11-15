// @vitest-environment jsdom
//
// story 4906 (lap 3 · PO 11-14) — the line above the composer: «홈에서 쓴 글을 가장 최근 방 ‹방 이름›에 옮겨 두었어요 — … 바로 보내지 않았어요». It is drawn ABOVE the input, only while the moved
// text is in the box, and goes when the person sends it or empties the box (editing it keeps it). Harness as chat-view.4761.test.tsx; ChatInput is replaced by a box that mirrors the real
// contract: it seeds from `prefillCommand` and reports its whole text through `onDraftChange` (the real ChatInput's side is pinned in chat-input.4906-draft-change.test.tsx).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useEffect, useState } from 'react';
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
vi.mock('./chat-input', () => ({
  ChatInput: ({ prefillCommand, onDraftChange, onSend }: { prefillCommand?: { text: string } | null; onDraftChange?: (t: string) => void; onSend: (c: string) => Promise<void> | void }) => {
    const [text, setText] = useState('');
    useEffect(() => { if (prefillCommand) setText(prefillCommand.text); }, [prefillCommand]);
    useEffect(() => { onDraftChange?.(text); }, [text, onDraftChange]);
    return (
      <div data-testid="mock-input-wrap">
        <textarea data-testid="mock-input" value={text} onChange={(e) => setText(e.target.value)} />
        <button type="button" data-testid="mock-send" onClick={() => { void onSend(text); setText(''); }}>send</button>
      </div>
    );
  },
}));

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
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string }) => {
    if (init?.method === 'POST') return { ok: true, json: async () => ({ data: { id: 'm1' } }) };
    if (typeof url === 'string' && url.includes('/messages?')) return { ok: true, json: async () => ({ data: [], meta: { next_cursor: null, has_more: false } }) };
    return { ok: true, json: async () => ({ data: [] }) };
  }));
});
afterEach(async () => {
  window.sessionStorage.clear();
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
});

const NOTICE = koMessages.chats.composeMovedNotice.replace('{room}', 'MCP Repro');

async function mount(props: { composeNotice?: string; composeNoticeId?: string; initialComposeText?: string }) {
  const { ChatView } = await import('./chat-view');
  const { ChatRailProvider } = await import('../../app/(authenticated)/chats/chat-rail-context');
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <ChatRailProvider><ChatView threadId="thread-1" currentTeamMemberId="me-1" {...props} /></ChatRailProvider>
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

const notice = () => container.querySelector('[data-testid="compose-moved-notice"]') as HTMLElement | null;
const input = () => container.querySelector('[data-testid="mock-input"]') as HTMLTextAreaElement;
async function typeInto(value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => { setter.call(input(), value); input().dispatchEvent(new Event('input', { bubbles: true })); });
}

describe('ChatView — the «moved from 홈» line above the composer (4906)', () => {
  it('⭐ a moved line is drawn with the room name, ABOVE the input, in a status region', async () => {
    await mount({ composeNotice: NOTICE, composeNoticeId: 'n1', initialComposeText: '릴리스 점검해 줘' });
    expect(input().value).toBe('릴리스 점검해 줘');
    expect(notice()).not.toBeNull(); // reverted (not drawn) → RED
    expect(notice()!.textContent).toContain('MCP Repro');
    expect(notice()!.querySelector('[role="status"]')).not.toBeNull(); // read politely, not an alert — nothing failed
    // «바로 위»: the note comes before the input in the page, and nothing but the composer's own wrapper sits between them
    expect(notice()!.compareDocumentPosition(container.querySelector('[data-testid="mock-input-wrap"]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('⭐ it does not close itself before the moved text has landed in the box (the first, empty report of the box)', async () => {
    await mount({ composeNotice: NOTICE, composeNoticeId: 'n1', initialComposeText: '릴리스 점검해 줘' });
    expect(notice()).not.toBeNull(); // reverted (any empty report closes it) → RED
  });

  it('⭐ the person sends the line → the note is gone', async () => {
    await mount({ composeNotice: NOTICE, composeNoticeId: 'n1', initialComposeText: '릴리스 점검해 줘' });
    await act(async () => { (container.querySelector('[data-testid="mock-send"]') as HTMLButtonElement).click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(notice()).toBeNull();
  });

  it('⭐ the person empties the box → the note is gone', async () => {
    await mount({ composeNotice: NOTICE, composeNoticeId: 'n1', initialComposeText: '릴리스 점검해 줘' });
    await typeInto('');
    expect(notice()).toBeNull(); // reverted (never closes) → RED
  });

  it('editing the line (still text in the box) keeps the note', async () => {
    await mount({ composeNotice: NOTICE, composeNoticeId: 'n1', initialComposeText: '릴리스 점검해 줘' });
    await typeInto('릴리스 점검해 줘 — 오늘 안에');
    expect(notice()).not.toBeNull();
  });

  it('⭐ after it was sent, a reload / a visit back to the marked URL (same room, same text) does NOT bring the note back — it would claim «not sent» about a sent line', async () => {
    await mount({ composeNotice: NOTICE, composeNoticeId: 'n1', initialComposeText: '릴리스 점검해 줘' });
    await act(async () => { (container.querySelector('[data-testid="mock-send"]') as HTMLButtonElement).click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(notice()).toBeNull();
    await act(async () => { root.unmount(); });
    root = createRoot(container); // the tab stays, the page is loaded again from the same marked URL
    await mount({ composeNotice: NOTICE, composeNoticeId: 'n1', initialComposeText: '릴리스 점검해 줘' });
    expect(notice()).toBeNull(); // reverted (no memory) → the note is back → RED
  });

  it('⭐ a LATER hand-over of the SAME text into the SAME room (a new id) is a new note — the old «done» memory must not hide it', async () => {
    await mount({ composeNotice: NOTICE, composeNoticeId: 'n1', initialComposeText: 'hi' });
    await act(async () => { (container.querySelector('[data-testid="mock-send"]') as HTMLButtonElement).click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(notice()).toBeNull();
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await mount({ composeNotice: NOTICE, composeNoticeId: 'n2', initialComposeText: 'hi' }); // the person wrote «hi» on the home again and it was moved to this room again
    expect(notice()).not.toBeNull(); // reverted (memory keyed by room + text) → hidden → RED
  });

  it('⭐ sending a line in a room the person PICKED (?compose alone: no note, no id) writes no memory — a later hand-over of that text into the room still gets its note', async () => {
    await mount({ initialComposeText: 'hi' });
    await act(async () => { (container.querySelector('[data-testid="mock-send"]') as HTMLButtonElement).click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(Object.keys(window.sessionStorage).filter((k) => k.startsWith('sprintable:compose-note-done:'))).toEqual([]);
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await mount({ composeNotice: NOTICE, composeNoticeId: 'n3', initialComposeText: 'hi' });
    expect(notice()).not.toBeNull();
  });

  it('another room (the same id) is its own memory', async () => {
    await mount({ composeNotice: NOTICE, composeNoticeId: 'n1', initialComposeText: '릴리스 점검해 줘' });
    await act(async () => { (container.querySelector('[data-testid="mock-send"]') as HTMLButtonElement).click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(Object.keys(window.sessionStorage).some((k) => k.includes(':thread-1:n1'))).toBe(true); // keyed by room + hand-over id, not by the words
    expect(Object.keys(window.sessionStorage).every((k) => !k.includes('릴리스'))).toBe(true);
  });

  it('a room with no moved line has no note', async () => {
    await mount({});
    expect(notice()).toBeNull();
  });
});
