// @vitest-environment jsdom
//
// story 4890 (UI-7 P10 · «누가 · 어느 방») — a chat line in the bell shows WHO (the sender's Avatar instead of the generic bell) and WHERE (the room's name under the headline, when the list carries it). Before: ten lines of
// «새 메시지 · 시각» told a person nothing about who or which room (measured: 0/10). Every other kind of line keeps the bell icon; a room with no name (a DM · a room the server withheld) draws no room line.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }) }));
vi.mock('@/hooks/use-sse-notifications', () => ({ useSseNotifications: () => undefined }));
const { NotificationBell, chatLineSender } = await import('./notification-bell');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const chat = (id: string, over: Record<string, unknown> = {}, sender: Record<string, unknown> | null = { id: 's1', name: '에이전트 N', type: 'agent', avatar_url: null, runtime_type: 'claude-code' }) => ({
  id, event_type: 'conversation.message_created', source_entity_type: 'conversation_message', source_entity_id: `${id}-m`,
  payload: { summary: '에이전트 N: 안녕하세요', conversation_id: 'room-1', ...(sender ? { sender } : {}) }, read_at: null, created_at: '2026-11-10T12:00:00Z', ...over,
});
const gate = () => ({
  id: 'gate-1', event_type: 'dispatched', source_entity_type: 'gate', source_entity_id: 'g-1',
  payload: { title: '결재 대기', event_type: 'gate.pending_approval', gate_name: '4890' }, read_at: null, created_at: '2026-11-10T12:00:00Z',
});

let container: HTMLDivElement;
let root: Root;
let listItems: unknown[] = [];
beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal('EventSource', class { addEventListener() {} close() {} });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/api/event-notifications?')) return new Response(JSON.stringify({ data: listItems, meta: { hasMore: false } }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ count: listItems.length }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function openBell() {
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><NotificationBell /></NextIntlClientProvider>);
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click(); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}
const panel = () => document.querySelector<HTMLElement>('[data-dropdown-panel="notification-bell"]')!;
const lines = () => Array.from(panel().querySelectorAll<HTMLElement>('ul > li'));

describe('NotificationBell — who and where on a chat line (story 4890)', () => {
  it('⭐a chat line draws the sender\'s Avatar and the room\'s name under the headline; the headline (the sender and the words) is unchanged', async () => {
    listItems = [chat('c1', { target_conversation_title: '개발 방' })];
    await openBell();
    const [line] = lines();
    expect(line!.querySelector('[data-testid="notification-line-avatar"]')).not.toBeNull();
    expect(line!.querySelector('[data-testid="notification-line-room"]')?.textContent).toBe('개발 방');
    expect(line!.querySelector('p.truncate.text-sm')?.textContent).toBe('에이전트 N: 안녕하세요');
  });

  it('⭐a chat line with no room name (a DM · a room the server withheld) draws the Avatar but no room line', async () => {
    listItems = [chat('c1'), chat('c2', { target_conversation_title: null })];
    await openBell();
    for (const line of lines()) {
      expect(line.querySelector('[data-testid="notification-line-avatar"]')).not.toBeNull();
      expect(line.querySelector('[data-testid="notification-line-room"]')).toBeNull();
    }
  });

  it('every other kind of line keeps the generic bell and has neither Avatar nor room line; a chat line with no sender in its payload falls back to the bell too', async () => {
    listItems = [gate(), chat('c-nosender', {}, null)];
    await openBell();
    for (const line of lines()) {
      expect(line.querySelector('[data-testid="notification-line-avatar"]')).toBeNull();
      expect(line.querySelector('[data-testid="notification-line-room"]')).toBeNull();
    }
  });

  it('⭐every line is a thumb-sized row (min height 56)', async () => {
    listItems = [chat('c1'), gate()];
    await openBell();
    for (const line of lines()) expect(line.querySelector('button')!.className).toContain('min-h-14');
  });
});

describe('chatLineSender — what a line says about who wrote it', () => {
  const row = (event_type: string, sender: unknown) => ({ event_type, payload: { sender } as Record<string, unknown> });
  it('reads the message_created / mention sender (name · avatar · agent or person · runtime); nothing for other kinds, a missing or blank name', () => {
    expect(chatLineSender(row('conversation.message_created', { name: '유나', type: 'human', avatar_url: 'https://x/y.png' }))).toEqual({ name: '유나', avatarUrl: 'https://x/y.png', actorType: 'human', runtimeType: null });
    expect(chatLineSender(row('conversation:mention', { name: '에이전트', type: 'agent', runtime_type: 'codex' }))).toEqual({ name: '에이전트', avatarUrl: null, actorType: 'agent', runtimeType: 'codex' });
    expect(chatLineSender(row('dispatched', { name: '유나', type: 'human' }))).toBeNull();
    expect(chatLineSender(row('conversation.message_created', { name: '   ' }))).toBeNull();
    expect(chatLineSender(row('conversation.message_created', undefined))).toBeNull();
  });
});
