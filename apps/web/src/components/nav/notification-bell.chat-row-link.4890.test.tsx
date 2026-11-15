// @vitest-environment jsdom
//
// story 4890 (UI-7 AC5 «알림에서 들어가기») — a chat line in the bell (a message · a mention) opens its ROOM. Before this the line had no link: tapping it only marked it read and closed the panel
// (dev 11-12, Android emulator: the address did not change). The room id rides in the message payload (`conversation_id`).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { RealtimeProvider } from '@/components/realtime-provider';

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, replace: vi.fn(), back: vi.fn() }) }));
const { NotificationBell, getEntityHref } = await import('./notification-bell');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('getEntityHref — chat lines open the room (story 4890)', () => {
  const base = { target_project_id: null, target_doc_slug: null, event_type: 'conversation.message_created' } as const;

  it('a message line opens /chats/<conversation_id> from the payload', () => {
    expect(getEntityHref({ ...base, source_entity_type: 'conversation_message', source_entity_id: 'm-1', payload: { conversation_id: 'c-1' } })).toBe('/chats/c-1');
  });

  it('a mention line (same entity type) opens the room too', () => {
    expect(getEntityHref({ ...base, event_type: 'conversation:mention', source_entity_type: 'conversation_message', source_entity_id: 'm-2', payload: { conversation_id: 'c-2' } })).toBe('/chats/c-2');
  });

  it('a row about the conversation itself opens its own id; with a payload id the payload wins', () => {
    expect(getEntityHref({ ...base, source_entity_type: 'conversation', source_entity_id: 'c-3', payload: null })).toBe('/chats/c-3');
    expect(getEntityHref({ ...base, source_entity_type: 'conversation_message', source_entity_id: 'm-4', payload: { conversation_id: 'c-4' } })).toBe('/chats/c-4');
  });

  it('a live (SSE) frame has no `source` ids and no nested payload — its top-level room id opens the room', () => {
    expect(getEntityHref({ ...base, source_entity_type: null, source_entity_id: null, payload: null, conversation_id: 'c-9' })).toBe('/chats/c-9');
    expect(getEntityHref({ event_type: 'conversation:mention', source_entity_type: null, source_entity_id: null, payload: null, target_project_id: null, target_doc_slug: null, conversation_id: 'c-10' })).toBe('/chats/c-10');
  });

  it('a line for a room the person cannot read now (content_withheld) opens nothing — the room would answer 404', () => {
    expect(getEntityHref({ ...base, source_entity_type: 'conversation_message', source_entity_id: 'm-11', payload: { conversation_id: 'c-11', content_withheld: true } })).toBeNull();
    // a live (SSE) frame carries the flag at the top level (flat), with no nested payload
    expect(getEntityHref({ event_type: 'conversation:mention', source_entity_type: null, source_entity_id: null, payload: null, target_project_id: null, target_doc_slug: null, conversation_id: 'c-13', content_withheld: true })).toBeNull();
  });

  it('negative controls — a message line with no room id anywhere opens nothing; a project on the row is carried; other kinds are untouched', () => {
    expect(getEntityHref({ ...base, source_entity_type: 'conversation_message', source_entity_id: 'm-5', payload: {} })).toBeNull();
    expect(getEntityHref({ ...base, source_entity_type: 'conversation_message', source_entity_id: 'm-6', payload: { conversation_id: '' } })).toBeNull();
    expect(getEntityHref({ ...base, source_entity_type: 'conversation_message', source_entity_id: 'm-8', payload: { conversation_id: 'c-8' }, target_project_id: 'p-1' })).toBe('/chats/c-8?p=p-1');
    expect(getEntityHref({ event_type: 'story_status_changed', source_entity_type: 'story', source_entity_id: 's-1', payload: null, target_project_id: null, target_doc_slug: null })).toBe('/flow?story=s-1');
    expect(getEntityHref({ event_type: 'story_status_changed', source_entity_type: null, source_entity_id: null, payload: null, target_project_id: null, target_doc_slug: null, conversation_id: 'c-12' })).toBeNull();
  });
});

describe('NotificationBell — tapping a chat line goes to the room (story 4890)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    push.mockClear();
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    vi.stubGlobal('EventSource', class { addEventListener() {} close() {} });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/event-notifications?')) {
        const item = {
          id: 'n1', event_type: 'conversation.message_created', source_entity_type: 'conversation_message', source_entity_id: 'm-1',
          payload: { summary: '채팅 줄', conversation_id: 'c-1' }, read_at: null, created_at: '2026-11-12T00:00:00Z',
        };
        return new Response(JSON.stringify({ data: [item], meta: { hasMore: false } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ count: 1 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    vi.unstubAllGlobals();
  });

  it('the line pushes /chats/<room> and closes the panel', async () => {
    await act(async () => {
      root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><NotificationBell /></NextIntlClientProvider>);
    });
    const bell = document.body.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
    await act(async () => { bell.click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const overlay = document.body.querySelector<HTMLElement>('[role="dialog"][aria-label]')!;
    const row = [...overlay.querySelectorAll('button')].find((b) => b.textContent?.includes('채팅 줄'))!;
    expect(row).toBeTruthy();
    await act(async () => { row.click(); });
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith('/chats/c-1');
    expect(document.body.querySelector('[role="dialog"][aria-label]')).toBeNull(); // the panel closed
  });

  it('a line that arrived LIVE (SSE frame: flat, no source ids) also goes to its room', async () => {
    class FakeEventSource {
      static instances: FakeEventSource[] = [];
      listeners: Record<string, Array<(e: { data: string }) => void>> = {};
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public url: string) { FakeEventSource.instances.push(this); }
      addEventListener(type: string, cb: (e: { data: string }) => void) { (this.listeners[type] ??= []).push(cb); }
      close() {}
      emit(type: string, data: unknown) { for (const cb of this.listeners[type] ?? []) cb({ data: JSON.stringify(data) }); }
    }
    vi.stubGlobal('EventSource', FakeEventSource);
    await act(async () => {
      root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><RealtimeProvider currentTeamMemberId="me-1"><NotificationBell /></RealtimeProvider></NextIntlClientProvider>);
    });
    const bell = document.body.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
    await act(async () => { bell.click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    // the live frame as the BE pushes it: the message's keys at the top level, no `source`, no nested `payload`
    await act(async () => {
      FakeEventSource.instances[0]!.emit('notification', {
        event_id: 'e-live', event_type: 'conversation.message_created', conversation_id: 'c-live', content: '라이브 줄', sender: { name: '에이전트', type: 'agent' }, created_at: '2026-11-12T01:00:00Z',
      });
    });
    const overlay = document.body.querySelector<HTMLElement>('[role="dialog"][aria-label]')!;
    const rows = [...overlay.querySelectorAll<HTMLButtonElement>('li button')];
    expect(rows.length).toBe(2); // the live line (first) + the listed one
    await act(async () => { rows[0]!.click(); });
    expect(push).toHaveBeenCalledWith('/chats/c-live');
  });

  it('a live line for a room the person cannot read (content_withheld, top level) opens nothing', async () => {
    class FakeEventSource {
      static instances: FakeEventSource[] = [];
      listeners: Record<string, Array<(e: { data: string }) => void>> = {};
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public url: string) { FakeEventSource.instances.push(this); }
      addEventListener(type: string, cb: (e: { data: string }) => void) { (this.listeners[type] ??= []).push(cb); }
      close() {}
      emit(type: string, data: unknown) { for (const cb of this.listeners[type] ?? []) cb({ data: JSON.stringify(data) }); }
    }
    vi.stubGlobal('EventSource', FakeEventSource);
    await act(async () => {
      root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><RealtimeProvider currentTeamMemberId="me-1"><NotificationBell /></RealtimeProvider></NextIntlClientProvider>);
    });
    const bell = document.body.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
    await act(async () => { bell.click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => {
      FakeEventSource.instances[0]!.emit('notification', {
        event_id: 'e-w', event_type: 'conversation:mention', conversation_id: 'c-w', content: '', content_withheld: true, sender: { name: '누군가', type: 'human' }, created_at: '2026-11-12T01:00:00Z',
      });
    });
    const overlay = document.body.querySelector<HTMLElement>('[role="dialog"][aria-label]')!;
    const rows = [...overlay.querySelectorAll<HTMLButtonElement>('li button')];
    expect(rows.length).toBe(2);
    await act(async () => { rows[0]!.click(); });
    expect(push).not.toHaveBeenCalled();
  });
});
