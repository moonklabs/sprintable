// @vitest-environment jsdom
//
// story #4440 — a person's own new message now also reaches their other tabs and devices (the server echoes it to all their
// connections, with the sending tab's nonce). This tab drops its own echo — by the nonce even when the echo arrives before
// the send answer (PO 19:37Z), by the id after — and a message of mine is never unread anywhere.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  isEchoOfSentHere, isOwnMessage, newClientNonce, sentMessageFromAnswer, useChatSse,
} from './use-chat-sse';
import { useChatUnreadTotal } from './use-chat-unread-total';

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

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ count: 0 }) })) as unknown as typeof fetch);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

const ME = 'member-me';
const msg = (id: string, extra: Record<string, unknown> = {}) => ({
  id, conversation_id: 'c1', content: `body ${id}`, created_at: '2026-09-30T20:00:00Z', sender: { id: ME, name: '나', type: 'human' }, ...extra,
});

function ChatHarness({ onMessage }: { onMessage: (p: Record<string, unknown>) => void }) {
  useChatSse({ currentTeamMemberId: ME, onConversationMessage: onMessage });
  return null;
}

describe('useChatSse — this tab drops its own echo (#4440)', () => {
  it('echo first, send answer after: the nonce recognizes it before the id is known — the consumer never sees it', async () => {
    const seen: Record<string, unknown>[] = [];
    await act(async () => { root.render(<ChatHarness onMessage={(p) => seen.push(p)} />); });
    const es = FakeEventSource.instances[FakeEventSource.instances.length - 1]!;

    const nonce = newClientNonce(); // made before the request, as the send paths do
    act(() => { es.emit('conversation.message_created', msg('m-echo', { client_nonce: nonce })); }); // the echo wins the race
    sentMessageFromAnswer({ data: msg('m-echo') }); // then the send answer
    act(() => { es.emit('conversation.message_created', msg('m-echo')); }); // a late duplicate without the nonce: known by id now

    expect(seen).toEqual([]);
  });

  it('my message sent from another tab or device (an unknown nonce) comes through', async () => {
    const seen: Record<string, unknown>[] = [];
    await act(async () => { root.render(<ChatHarness onMessage={(p) => seen.push(p)} />); });
    const es = FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
    act(() => { es.emit('conversation.message_created', msg('m-other-tab', { client_nonce: 'from-the-desktop-app' })); });
    expect(seen.map((p) => p.id)).toEqual(['m-other-tab']);
  });

  it('the rules on their own', () => {
    const nonce = newClientNonce();
    expect(isEchoOfSentHere({ id: 'x', client_nonce: nonce })).toBe(true);
    expect(isEchoOfSentHere({ id: 'y', client_nonce: 'someone-else' })).toBe(false);
    sentMessageFromAnswer({ data: { id: 'z' } });
    expect(isEchoOfSentHere({ id: 'z' })).toBe(true);
    expect(isOwnMessage({ sender: { id: ME } }, ME)).toBe(true);
    expect(isOwnMessage({ created_by: ME }, ME)).toBe(true);
    expect(isOwnMessage({ sender: { id: 'someone' } }, ME)).toBe(false);
    expect(isOwnMessage({ sender: { id: ME } }, undefined)).toBe(false);
  });
});

describe('useChatUnreadTotal — a message of mine is never unread (#4440)', () => {
  it('my message from another tab does not raise the total; someone else\'s does', async () => {
    function Totals() {
      return <span data-testid="total">{useChatUnreadTotal(ME)}</span>;
    }
    const total = () => Number(container.querySelector('[data-testid="total"]')?.textContent);
    await act(async () => { root.render(<Totals />); await Promise.resolve(); });
    const es = FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
    const base = total();
    act(() => { es.emit('conversation.message_created', msg('mine-1', { client_nonce: 'from-the-desktop-app' })); });
    expect(total()).toBe(base);
    act(() => { es.emit('conversation.message_created', msg('theirs-1', { sender: { id: 'someone', name: 'A', type: 'human' } })); });
    expect(total()).toBe(base + 1);
  });
});


describe('useChatSse — onSentHere (#4442)', () => {
  it('a send answer from this tab reaches every onSentHere subscriber in the tab (the lists), with the message', async () => {
    const seen: Record<string, unknown>[] = [];
    function Lists() { useChatSse({ currentTeamMemberId: ME, onSentHere: (p) => seen.push(p) }); return null; }
    await act(async () => { root.render(<Lists />); });
    sentMessageFromAnswer({ data: msg('m-sent-here') });
    expect(seen.map((p) => p.id)).toEqual(['m-sent-here']);
    expect(seen[0]!.conversation_id).toBe('c1');
  });
});
