import { describe, expect, it } from 'vitest';
import { applyConversationMessageUpdate } from './chat-list-view';

// story 5053 — while the list is open, a new-message event lifts its room to the top WITHOUT a reload, whatever road the message came by: a card (approval · activation) is a message with words like any other.
// (The server's list order is raised at the database by the trigger of migration 0506 — this pins the live half, so a room does not sit at its old place until a refresh.)
describe('applyConversationMessageUpdate — a room that gets a message goes to the top (story 5053)', () => {
  const room = (id: string, at: string) => ({ id, type: 'dm', title: id, latest_message: { content: 'old', created_at: at }, updated_at: at, unread_count: 0 });
  const list = [room('top', '2026-11-27T09:00:00Z'), room('mid', '2026-11-27T08:00:00Z'), room('old', '2026-08-22T01:00:00Z')] as never;

  it('⭐a card message into the OLDEST room lifts it above every other row, with its new line and one unread', () => {
    const next = applyConversationMessageUpdate(list, {
      conversation_id: 'old', content: '[agent] 스프린트 닫기 — 승인해 주세요', created_at: '2026-11-27T09:11:58Z', sender: { id: 'agent-1', type: 'agent' },
      card: { kind: 'agent_action', ref: '5c1f0a52-3b7e-4e0d-9a6f-1d2c3b4a5e6f' },
    }, () => {}, 'me');
    expect(next.map((c) => c.id)).toEqual(['old', 'top', 'mid']);
    expect(next[0]!.updated_at).toBe('2026-11-27T09:11:58Z');
    expect(next[0]!.latest_message?.content).toContain('승인해 주세요');
    expect(next[0]!.unread_count).toBe(1);
  });

  it('the room already at the top stays there; the rest keep their order', () => {
    const next = applyConversationMessageUpdate(list, { conversation_id: 'top', content: '또', created_at: '2026-11-27T09:30:00Z' }, () => {}, 'me');
    expect(next.map((c) => c.id)).toEqual(['top', 'mid', 'old']);
  });

  it('a message for a room not in the list asks for a re-read instead of being dropped', () => {
    let reads = 0;
    const next = applyConversationMessageUpdate(list, { conversation_id: 'unknown-room', content: 'x', created_at: '2026-11-27T09:30:00Z' }, () => { reads += 1; }, 'me');
    expect(reads).toBe(1);
    expect(next).toBe(list);
  });
});
