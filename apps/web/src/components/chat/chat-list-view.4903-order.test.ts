// @vitest-environment jsdom
// story 4903 AC3 — an OLDER message never takes the place of a newer latest message in a room row. A reconnect's backfill re-delivers the last few events in any order; after a delete the row used
// to show the message BEFORE the deleted one («먼저 보낸 글» — dev, two accounts, 11-12).
import { describe, expect, it, vi } from 'vitest';
import { applyConversationMessageUpdate } from './chat-list-view';
import { announceChatMessageDeleted, forgetKnownDeletedForTests } from '@/lib/chat-message-deleted';

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

  it('⭐ a re-delivered event of a message already known to be deleted changes nothing — not even at the EQUAL moment (no unread, no updated_at, no preview)', () => {
    forgetKnownDeletedForTests();
    try {
      const prev = [row({ content: '', created_at: T2 })];
      announceChatMessageDeleted({ conversationId: 'c1', createdAt: T2, messageId: 'm-gone', threadId: null, deletedAt: T3 });
      const replay = applyConversationMessageUpdate(prev, { ...payload('지운 글 본문', T2), id: 'm-gone' }, vi.fn(), 'me');
      expect(replay).toBe(prev); // reverted (no known-deleted check) → the equal moment passes the order guard: unread 1, the words back in the preview
      // another message at the same moment is NOT that message: it applies
      const other = applyConversationMessageUpdate(prev, { ...payload('다른 글', T2), id: 'm-other' }, vi.fn(), 'me') as unknown as Array<{ latest_message: { content: string } }>;
      expect(other[0]!.latest_message.content).toBe('다른 글');
      // …and the same id in ANOTHER room is not it either
      const room2 = applyConversationMessageUpdate([{ ...(prev[0] as object), id: 'c2' } as never], { ...payload('남의 방 글', T2), conversation_id: 'c2', id: 'm-gone' }, vi.fn(), 'me') as unknown as Array<{ latest_message: { content: string } }>;
      expect(room2[0]!.latest_message.content).toBe('남의 방 글');
    } finally {
      forgetKnownDeletedForTests();
    }
  });
});
