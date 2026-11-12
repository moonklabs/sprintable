// @vitest-environment jsdom
// story 4903 AC3 — the server's `conversation.message_deleted` frame (ids and moments only) as a local announcement, and the tombstone helper the room and its thread share.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { announceChatMessageDeleted, blankKnownDeletedPreviews, forgetKnownDeletedForTests, knownDeletedAt, parseMessageDeletedFrame, tombstoneKnownDeleted, withMessageTombstoned } from './chat-message-deleted';

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


describe('what is known to be deleted (a fetch already in flight when the frame arrived must not bring the text back)', () => {
  beforeEach(() => { forgetKnownDeletedForTests(); });
  afterEach(() => { vi.useRealTimers(); forgetKnownDeletedForTests(); });
  const frame = (messageId: string | undefined, conversationId = 'c1', createdAt = '2026-11-12T01:00:00.000001Z') => announceChatMessageDeleted({ conversationId, createdAt, messageId, threadId: null, deletedAt: '2026-11-12T01:05:00Z' });

  it('⭐ a message announced as deleted is a tombstone in any list of ITS room afterwards — whenever the list arrives; another room\'s list is untouched; nothing to change → the same list', () => {
    frame('m1');
    const late = [{ id: 'm1', content: '늦게 온 응답의 본문', deleted_at: null }, { id: 'm2', content: '다른 글', deleted_at: null }];
    const fixed = tombstoneKnownDeleted(late, 'c1');
    expect(fixed[0]).toEqual({ id: 'm1', content: '', deleted_at: '2026-11-12T01:05:00Z' }); // reverted (nothing remembered) → the late response's words stay
    expect(fixed[1]).toBe(late[1]);
    expect(tombstoneKnownDeleted(late, 'another-room')).toBe(late);
    expect(tombstoneKnownDeleted(fixed, 'c1')).toBe(fixed);
    expect(knownDeletedAt('c1', 'm1')).toBe('2026-11-12T01:05:00Z');
    expect(knownDeletedAt('another-room', 'm1')).toBeUndefined();
  });

  it('an announcement without a message id (this screen\'s own delete) is not remembered', () => {
    frame(undefined);
    expect(knownDeletedAt('c1', 'm1')).toBeUndefined();
    const list = [{ id: 'm1', content: 'x', deleted_at: null }];
    expect(tombstoneKnownDeleted(list, 'c1')).toBe(list);
  });

  it('⭐ a room row whose latest message is a known-deleted one is blanked like the server\'s refetch (no words · no attachment flag · no event card); the others and the same list when nothing changes', () => {
    frame('m1', 'c1', '2026-11-12T01:00:00.000001Z');
    const rows = [
      { id: 'c1', latest_message: { content: '지운 글', created_at: '2026-11-12T01:00:00.000001+00:00', has_attachments: true, event: { event_key: 'k' } } },
      { id: 'c2', latest_message: { content: '다른 방', created_at: '2026-11-12T01:00:00.000001Z' } },
      { id: 'c3', latest_message: null },
    ];
    const next = blankKnownDeletedPreviews(rows);
    expect(next[0]!.latest_message).toEqual({ content: '', created_at: '2026-11-12T01:00:00.000001+00:00', event: null }); // reverted (nothing remembered) → the words stay
    expect(next[1]).toBe(rows[1]);
    expect(blankKnownDeletedPreviews(next)).toBe(next);
    expect(blankKnownDeletedPreviews([rows[1]!])).toEqual([rows[1]]);
  });

  it('it is bounded and it expires: the newest 500 are kept; after 30 minutes a deletion is forgotten', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-12T01:00:00Z'));
    for (let i = 0; i < 501; i += 1) frame(`m${i}`);
    expect(knownDeletedAt('c1', 'm0'), 'the oldest of 501 is dropped').toBeUndefined();
    expect(knownDeletedAt('c1', 'm500')).toBe('2026-11-12T01:05:00Z');
    vi.setSystemTime(new Date('2026-11-12T01:31:00Z'));
    expect(knownDeletedAt('c1', 'm500'), 'after 30 minutes').toBeUndefined();
    const list = [{ id: 'm500', content: 'x', deleted_at: null }];
    expect(tombstoneKnownDeleted(list, 'c1')).toBe(list);
  });
});
