// story 4903 AC3 — an OLDER message never takes the place of a newer latest message in a room row. A reconnect's backfill re-delivers the last few events in any order; after a delete the row used
// to show the message BEFORE the deleted one («먼저 보낸 글» — dev, two accounts, 11-12).
import { describe, expect, it, vi } from 'vitest';
import { applyConversationMessageUpdate } from './chat-list-view';

const T1 = '2026-11-12T01:00:00.000001+00:00'; // the earlier message
const T2 = '2026-11-12T01:00:05.000000+00:00'; // the deleted latest message (its row says «메시지 없음»)
const T3 = '2026-11-12T01:00:09.000000+00:00';
const row = (latest: { content: string; created_at: string } | null) => ({ id: 'c1', title: 'room', type: 'dm', latest_message: latest, updated_at: T2, unread_count: 0, participants: [] }) as never;
const payload = (content: string, created_at: string) => ({ conversation_id: 'c1', content, created_at, sender: { id: 'other' } });

describe('applyConversationMessageUpdate — time order', () => {
  it('⭐ an event for an OLDER message does not replace the row\'s newer latest message (and changes nothing else: the same list comes back)', () => {
    const prev = [row({ content: '', created_at: T2 })];
    const next = applyConversationMessageUpdate(prev, payload('먼저 보낸 글', T1), vi.fn(), 'me');
    expect(next).toBe(prev); // reverted (no order check) → the row now says «먼저 보낸 글»
  });

  it('a NEWER message replaces it (and counts as unread for someone else); the SAME moment replaces too (a re-delivery of the latest)', () => {
    const prev = [row({ content: '', created_at: T2 })];
    const newer = applyConversationMessageUpdate(prev, payload('새 글', T3), vi.fn(), 'me') as unknown as Array<{ latest_message: { content: string }; unread_count: number }>;
    expect(newer[0]!.latest_message.content).toBe('새 글');
    expect(newer[0]!.unread_count).toBe(1);
    const same = applyConversationMessageUpdate(prev, payload('같은 시각', T2), vi.fn(), 'me') as unknown as Array<{ latest_message: { content: string } }>;
    expect(same[0]!.latest_message.content).toBe('같은 시각');
  });

  it('a row with no latest message yet · or an unreadable time keeps the old behaviour (the update applies)', () => {
    const empty = applyConversationMessageUpdate([row(null)], payload('첫 글', T1), vi.fn(), 'me') as unknown as Array<{ latest_message: { content: string } }>;
    expect(empty[0]!.latest_message.content).toBe('첫 글');
    const odd = applyConversationMessageUpdate([row({ content: 'x', created_at: 'not a time' })], payload('다음', T1), vi.fn(), 'me') as unknown as Array<{ latest_message: { content: string } }>;
    expect(odd[0]!.latest_message.content).toBe('다음');
  });
});
