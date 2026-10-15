/**
 * story #4440 — the conversation lists (legacy list · v3 rail) after a new message: my own message (now arriving from my
 * other tabs and devices) moves the row up with its latest line but is never unread; someone else's is, as before.
 */
import { describe, expect, it } from 'vitest';
import { applyConversationMessageUpdate } from './chat-list-view';
import { threadsAfterMessage } from '../chat-v3/chat-v3-screen';

const ME = 'member-me';
const mine = { conversation_id: 'c2', content: '내가 보낸 말', created_at: '2026-09-30T20:00:00Z', sender: { id: ME } };
const theirs = { ...mine, content: '남이 보낸 말', sender: { id: 'someone' } };

describe('legacy conversation list (#4440)', () => {
  const rows = () => [
    { id: 'c1', unread_count: 0 }, { id: 'c2', unread_count: 0 },
  ] as unknown as Parameters<typeof applyConversationMessageUpdate>[0];

  it('my message: up to the top with its line, unread unchanged', () => {
    const next = applyConversationMessageUpdate(rows(), mine, () => {}, ME);
    expect(next[0]!.id).toBe('c2');
    expect(next[0]!.latest_message).toEqual({ content: '내가 보낸 말', created_at: mine.created_at });
    expect(next[0]!.unread_count).toBe(0);
  });

  it('someone else\'s message: unread + 1 as before', () => {
    expect(applyConversationMessageUpdate(rows(), theirs, () => {}, ME)[0]!.unread_count).toBe(1);
  });
});

describe('v3 thread rail (#4440)', () => {
  const threads = () => [
    { id: 'c1', participants: [], latest_message: null, unread_count: 0 },
    { id: 'c2', participants: [], latest_message: null, unread_count: 0 },
  ] as unknown as Parameters<typeof threadsAfterMessage>[0];

  it('my message on a thread that is not open: up with its line, unread unchanged', () => {
    const { next } = threadsAfterMessage(threads(), mine, { selectedId: 'c1', meId: ME });
    expect(next![0]!.id).toBe('c2');
    expect(next![0]!.latest_message).toEqual({ content: '내가 보낸 말', created_at: mine.created_at });
    expect(next![0]!.unread_count).toBe(0);
  });

  it('someone else\'s message on a thread that is not open: unread + 1; on the open thread: no unread', () => {
    expect(threadsAfterMessage(threads(), theirs, { selectedId: 'c1', meId: ME }).next![0]!.unread_count).toBe(1);
    expect(threadsAfterMessage(threads(), theirs, { selectedId: 'c2', meId: ME }).next![0]!.unread_count).toBe(0);
  });

  it('a thread not in the rail yet asks for a reload', () => {
    expect(threadsAfterMessage(threads(), { ...theirs, conversation_id: 'c9' }, { selectedId: 'c1', meId: ME }).unknown).toBe(true);
  });
});
