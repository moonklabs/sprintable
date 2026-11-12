// story 4903 AC3 — the server's `conversation.message_deleted` frame (ids and moments only) as a local announcement, and the tombstone helper the room and its thread share.
import { describe, expect, it } from 'vitest';
import { parseMessageDeletedFrame, withMessageTombstoned } from './chat-message-deleted';

const FRAME = { event_type: 'conversation.message_deleted', conversation_id: 'c1', id: 'm1', thread_id: null, created_at: '2026-11-12T01:00:00.123456+00:00', deleted_at: '2026-11-12T01:05:00+00:00', recipient_id: 'me' };

describe('parseMessageDeletedFrame', () => {
  it('a frame (a string as the stream delivers it, or an object) becomes the announcement: the room · the message · its own moment · its thread · when it was deleted', () => {
    const expected = { conversationId: 'c1', createdAt: FRAME.created_at, messageId: 'm1', threadId: null, deletedAt: FRAME.deleted_at };
    expect(parseMessageDeletedFrame(JSON.stringify(FRAME))).toEqual(expected);
    expect(parseMessageDeletedFrame(FRAME)).toEqual(expected);
    expect(parseMessageDeletedFrame(JSON.stringify({ ...FRAME, thread_id: 't9' }))?.threadId).toBe('t9');
  });

  it('anything that is not such a frame is null: not JSON · no message id · no room · no moment', () => {
    expect(parseMessageDeletedFrame('not json')).toBeNull();
    expect(parseMessageDeletedFrame('null')).toBeNull();
    for (const key of ['id', 'conversation_id', 'created_at']) {
      const { [key]: _gone, ...rest } = FRAME as Record<string, unknown>;
      expect(parseMessageDeletedFrame(JSON.stringify(rest)), `without ${key}`).toBeNull();
    }
  });
});

describe('withMessageTombstoned', () => {
  const list = [{ id: 'a', content: 'one', deleted_at: null }, { id: 'b', content: 'two', deleted_at: null }];
  it('turns that message into a tombstone (content gone · deleted_at set) and leaves the others', () => {
    const next = withMessageTombstoned(list, 'b', '2026-11-12T01:05:00+00:00');
    expect(next[1]).toEqual({ id: 'b', content: '', deleted_at: '2026-11-12T01:05:00+00:00' });
    expect(next[0]).toBe(list[0]);
  });
  it('is the SAME list when there is nothing to change (an unknown id · an already-deleted message): no needless re-render', () => {
    expect(withMessageTombstoned(list, 'zzz', null)).toBe(list);
    const gone = [{ id: 'a', content: '', deleted_at: '2026-11-12T00:00:00Z' }];
    expect(withMessageTombstoned(gone, 'a', '2026-11-12T09:00:00Z')).toBe(gone);
  });
});
