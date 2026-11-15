// @vitest-environment jsdom
// story 4903 AC3 — the chats layout subscribes ONCE to the server's `conversation.message_deleted` frame and turns it into the local announcement the room · thread · list listen to.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CHAT_MESSAGE_DELETED_EVENT } from '@/lib/chat-message-deleted';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mux = vi.hoisted(() => ({ handlers: new Map<string, (raw: string) => void>(), unsubscribed: [] as string[], present: true }));
vi.mock('@/components/realtime-provider', () => ({
  useSseMultiplexerContext: () => (mux.present ? {
    subscribe: (name: string, handler: (raw: string) => void) => { mux.handlers.set(name, handler); return () => { mux.unsubscribed.push(name); mux.handlers.delete(name); }; },
  } : null),
}));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { mux.handlers.clear(); mux.unsubscribed.length = 0; mux.present = true; container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });

async function mount() {
  const { useChatMessageDeletedSse } = await import('./use-chat-message-deleted-sse');
  function Probe() { useChatMessageDeletedSse(); return null; }
  await act(async () => { root.render(<Probe />); });
}
const FRAME = JSON.stringify({ event_type: 'conversation.message_deleted', conversation_id: 'c1', id: 'm1', thread_id: null, created_at: '2026-11-12T01:00:00+00:00', deleted_at: '2026-11-12T01:05:00+00:00', recipient_id: 'me' });

describe('useChatMessageDeletedSse', () => {
  it('⭐ a frame becomes the local announcement (room · message · moment · thread · deleted_at)', async () => {
    await mount();
    expect([...mux.handlers.keys()], 'subscribed to the server frame by its name').toEqual(['conversation.message_deleted']); // reverted (no subscription) → []
    const heard: unknown[] = [];
    const listen = (e: Event) => heard.push((e as CustomEvent).detail);
    window.addEventListener(CHAT_MESSAGE_DELETED_EVENT, listen);
    await act(async () => { mux.handlers.get('conversation.message_deleted')!(FRAME); });
    window.removeEventListener(CHAT_MESSAGE_DELETED_EVENT, listen);
    expect(heard).toEqual([{ conversationId: 'c1', createdAt: '2026-11-12T01:00:00+00:00', messageId: 'm1', threadId: null, deletedAt: '2026-11-12T01:05:00+00:00' }]); // reverted (the handler does nothing) → []
  });

  it('⭐ the SAME frame twice (the replay buffer after a reconnect + the live copy: one stable event_id) announces once; another frame announces again', async () => {
    await mount();
    const heard: unknown[] = [];
    const listen = (e: Event) => heard.push((e as CustomEvent).detail);
    window.addEventListener(CHAT_MESSAGE_DELETED_EVENT, listen);
    const withId = (eventId: string, messageId: string) => JSON.stringify({ ...JSON.parse(FRAME), event_id: eventId, id: messageId });
    await act(async () => {
      mux.handlers.get('conversation.message_deleted')!(withId('e1', 'm1'));
      mux.handlers.get('conversation.message_deleted')!(withId('e1', 'm1')); // reverted (no dedup) → heard twice
      mux.handlers.get('conversation.message_deleted')!(withId('e2', 'm2'));
    });
    window.removeEventListener(CHAT_MESSAGE_DELETED_EVENT, listen);
    expect((heard as Array<{ messageId: string }>).map((d) => d.messageId)).toEqual(['m1', 'm2']);
  });

  it('a frame that is not one (not JSON · no message id) announces nothing', async () => {
    await mount();
    const heard: unknown[] = [];
    const listen = (e: Event) => heard.push((e as CustomEvent).detail);
    window.addEventListener(CHAT_MESSAGE_DELETED_EVENT, listen);
    await act(async () => { mux.handlers.get('conversation.message_deleted')!('garbage'); mux.handlers.get('conversation.message_deleted')!(JSON.stringify({ conversation_id: 'c1' })); });
    window.removeEventListener(CHAT_MESSAGE_DELETED_EVENT, listen);
    expect(heard).toEqual([]);
  });

  it('unsubscribes when the layout goes away; without a stream (no multiplexer) it does nothing and does not crash', async () => {
    await mount();
    await act(async () => { root.unmount(); });
    expect(mux.unsubscribed).toEqual(['conversation.message_deleted']);
    root = createRoot(container);
    mux.present = false;
    await mount();
    expect(mux.handlers.size).toBe(0);
  });
});
