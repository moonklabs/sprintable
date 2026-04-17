import { describe, expect, it } from 'vitest';
import { mergeReply } from './memo-detail';
import type { MemoDetailState, MemoReply } from './memo-state';

const baseMemo = {
  id: 'memo-1',
  title: 'Memo',
  content: 'content',
  status: 'open',
  memo_type: 'note',
  created_at: '2026-04-10T00:00:00.000Z',
  replies: [],
} satisfies MemoDetailState;

const reply = {
  id: 'reply-1',
  content: '![image](https://example.com/image.png)',
  created_by: 'user-1',
  review_type: 'comment',
  created_at: '2026-04-10T00:01:00.000Z',
} satisfies MemoReply;

describe('mergeReply', () => {
  it('appends a new reply', () => {
    const next = mergeReply(baseMemo, reply);

    expect(next.replies).toHaveLength(1);
    expect(next.reply_count).toBe(1);
    expect(next.latest_reply_at).toBe(reply.created_at);
  });

  it('ignores duplicate reply ids', () => {
    const withReply = mergeReply(baseMemo, reply);
    const next = mergeReply(withReply, reply);

    expect(next.replies).toHaveLength(1);
    expect(next.reply_count).toBe(1);
    expect(next.latest_reply_at).toBe(reply.created_at);
  });
});
