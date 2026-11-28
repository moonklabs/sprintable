// @vitest-environment jsdom
//
// story 5043 (C10 · PO 11-28) — a send that is sent AGAIN is ONE message, and a moved line that was sent does not come back. The live walk made the two defects the 6d measurement had only suspected («two identical messages»):
//  · the web made a NEW `client_nonce` for every call, so a send whose answer was lost and was pressed again was a second message — the token now belongs to the DRAFT (the same words again = the same token) and is let go when the server accepted the send;
//  · after a send that reached the server the address still carried `compose=…`, and a remount of the room put the moved line back into the box next to the message that was already sent — it is now seeded once.
// Harness as chat-view.compose-notice.4906.test.tsx (ChatInput is a box that mirrors its contract and hands its `onSend` to the test).
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

const probe: { send: ((c: string, mentioned?: string[], attachments?: Array<{ url: string }>) => Promise<void>) | null; prefill: { text: string; nonce: number } | null | undefined } = { send: null, prefill: undefined };
vi.mock('./chat-input', () => ({
  ChatInput: ({ prefillCommand, onDraftChange, onSend }: { prefillCommand?: { text: string; nonce: number } | null; onDraftChange?: (t: string) => void; onSend: (c: string) => Promise<void> }) => {
    const [text, setText] = useState('');
    probe.send = onSend; probe.prefill = prefillCommand;
    useEffect(() => { if (prefillCommand) setText(prefillCommand.text); }, [prefillCommand]);
    useEffect(() => { onDraftChange?.(text); }, [text, onDraftChange]);
    return (
      <div data-testid="mock-input-wrap">
        <textarea data-testid="mock-input" value={text} onChange={(e) => setText(e.target.value)} />
        <button type="button" data-testid="mock-send" onClick={() => { void onSend(text).then(() => setText(''), () => undefined); }}>send</button>
      </div>
    );
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let posts: Array<Record<string, unknown>>;
let postPlan: Array<'ok' | 'lost' | 'server-error' | 'conflict'>;

beforeEach(() => {
  posts = []; postPlan = [];
  probe.send = null; probe.prefill = undefined;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } });
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === 'POST' && typeof url === 'string' && /\/messages$/.test(url)) {   // (the sends only — the view also posts «read» marks and the like)
      posts.push(JSON.parse(init.body ?? '{}'));
      const plan = postPlan.shift() ?? 'ok';
      if (plan === 'lost') throw new TypeError('network error'); // the answer never came back
      if (plan === 'conflict') return { ok: false, status: 409, json: async () => ({ detail: 'client_nonce was already used for another message' }), text: async () => '' };
      if (plan === 'server-error') return { ok: false, status: 500, json: async () => ({}), text: async () => '' };
      return { ok: true, json: async () => ({ data: { id: `m${posts.length}`, content: 'x', created_at: new Date().toISOString(), created_by: 'me-1', conversation_id: 'thread-1' } }) };
    }
    if (init?.method === 'POST') return { ok: true, json: async () => ({}) };
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

async function mount(props: { composeNotice?: string; composeNoticeId?: string; initialComposeText?: string } = {}) {
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
const sendText = async (text: string, mentioned?: string[], attachments?: Array<{ url: string }>): Promise<'sent' | 'failed'> => {
  let out: 'sent' | 'failed' = 'sent';
  await act(async () => { try { await probe.send!(text, mentioned, attachments); } catch { out = 'failed'; } });
  return out;
};
const input = () => container.querySelector('[data-testid="mock-input"]') as HTMLTextAreaElement;

describe('ChatView — one token per draft (5043)', () => {
  it('⭐ the SAME words sent again after a send whose answer was lost carry the SAME token (the server answers with the message that is there)', async () => {
    await mount();
    postPlan = ['lost', 'ok'];
    expect(await sendText('same words')).toBe('failed');
    expect(await sendText('same words')).toBe('sent');
    expect(posts).toHaveLength(2);
    expect(typeof posts[0]!.client_nonce).toBe('string');
    expect(posts[1]!.client_nonce).toBe(posts[0]!.client_nonce); // reverted (a new token per call) → RED
  });

  it('⭐ a send the server refused (500) is the same draft too: the retry keeps the token', async () => {
    await mount();
    postPlan = ['server-error', 'ok'];
    expect(await sendText('retry me')).toBe('failed');
    expect(await sendText('retry me')).toBe('sent');
    expect(posts[1]!.client_nonce).toBe(posts[0]!.client_nonce);
  });

  it('⭐ other words are another send — a new token; and once a send was accepted, the same words typed again are a NEW message with a new token', async () => {
    await mount();
    postPlan = ['lost', 'ok', 'ok'];
    await sendText('first words');
    await sendText('other words');            // not a retry of the first
    await sendText('other words');            // accepted before → this is a second message of the same words, on purpose
    expect(posts).toHaveLength(3);
    expect(posts[1]!.client_nonce).not.toBe(posts[0]!.client_nonce);
    expect(posts[2]!.client_nonce).not.toBe(posts[1]!.client_nonce); // reverted (the token is never let go) → the third would be answered with the second → RED
  });
});

describe('ChatView — what makes a send «the same draft» (5043)', () => {
  it('⭐ the same words with other mentions, or other files, are ANOTHER send — a new token (a key of the words alone would hand the server the first send\'s token)', async () => {
    await mount();
    postPlan = ['lost', 'lost', 'lost'];
    await sendText('same words', ['m1']);
    await sendText('same words', ['m2']);
    await sendText('same words', ['m2'], [{ url: 'https://files/a.png' }]);
    expect(new Set(posts.map((b) => b.client_nonce)).size).toBe(3); // reverted (key = words only) → 1 → RED
  });

  it('⭐ a 409 (the server says the token was used for other words) is a failed send: the box keeps the words, the retry keeps the token', async () => {
    await mount();
    postPlan = ['conflict', 'ok'];
    expect(await sendText('words')).toBe('failed');
    expect(await sendText('words')).toBe('sent');
    expect(posts[1]!.client_nonce).toBe(posts[0]!.client_nonce);
  });

  it('⭐ two callers that interleave (the composer and a card\'s reply button share one send): the first one\'s token survives the second\'s success', async () => {
    await mount();
    postPlan = ['lost', 'ok', 'ok'];
    await sendText('draft A');      // the answer is lost
    await sendText('card reply B'); // another caller succeeds meanwhile
    await sendText('draft A');      // the person presses Send again
    expect(posts[2]!.client_nonce).toBe(posts[0]!.client_nonce); // reverted (ONE slot: B took it) → a new token → RED
    expect(posts[1]!.client_nonce).not.toBe(posts[0]!.client_nonce);
  });
});

describe('ChatView — the moved line is seeded once (5043)', () => {
  it('⭐ the person sends the moved line → the box is told it is gone (no prefill left for a remounted box)', async () => {
    await mount({ composeNotice: 'moved', composeNoticeId: 'n1', initialComposeText: 'moved words' });
    expect(probe.prefill).toEqual({ text: 'moved words', nonce: 0 });
    await act(async () => { (container.querySelector('[data-testid="mock-send"]') as HTMLButtonElement).click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(probe.prefill).toBeNull(); // reverted (the seed stays) → a remount of the box puts it back → RED
  });

  it('⭐ after it was sent, the room drawn AGAIN from the same marked address (compose= is still in it) does NOT put the line back into the box', async () => {
    await mount({ composeNotice: 'moved', composeNoticeId: 'n1', initialComposeText: 'moved words' });
    await act(async () => { (container.querySelector('[data-testid="mock-send"]') as HTMLButtonElement).click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await mount({ composeNotice: 'moved', composeNoticeId: 'n1', initialComposeText: 'moved words' });
    expect(input().value).toBe(''); // reverted (seeded on every mount) → 'moved words' → RED
    expect(probe.prefill).toBeNull();
  });

  it('a room the person PICKED (compose= alone, no hand-over id) keeps today\'s behaviour: seeded on every mount (there is no memory to ask)', async () => {
    await mount({ initialComposeText: 'picked words' });
    await act(async () => { (container.querySelector('[data-testid="mock-send"]') as HTMLButtonElement).click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await mount({ initialComposeText: 'picked words' });
    expect(input().value).toBe('picked words');
  });

  it('a LATER hand-over (a new id) of the same words into the same room is seeded again', async () => {
    await mount({ composeNotice: 'moved', composeNoticeId: 'n1', initialComposeText: 'hi' });
    await act(async () => { (container.querySelector('[data-testid="mock-send"]') as HTMLButtonElement).click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await mount({ composeNotice: 'moved', composeNoticeId: 'n2', initialComposeText: 'hi' });
    expect(input().value).toBe('hi');
  });
});
