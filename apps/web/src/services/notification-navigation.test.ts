import { describe, expect, it, vi } from 'vitest';
import { attachNotificationHrefs } from './notification-navigation';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;

function createSupabaseStub() {
  const docCommentsQuery = {
    select: vi.fn(() => docCommentsQuery),
    in: vi.fn().mockResolvedValue({
      data: [
        { id: 'comment-1', doc_id: 'doc-1' },
      ],
      error: null,
    }),
  };

  const docsQuery = {
    select: vi.fn(() => docsQuery),
    in: vi.fn().mockResolvedValue({
      data: [
        { id: 'doc-1', slug: 'ops-guide' },
        { id: 'doc-2', slug: 'runbook' },
      ],
      error: null,
    }),
  };

  return {
    from: vi.fn((table: string) => {
      if (table === 'doc_comments') return docCommentsQuery;
      if (table === 'docs') return docsQuery;
      throw new Error(`unexpected table: ${table}`);
    }),
  } as unknown as SupabaseClient;
}

describe('attachNotificationHrefs', () => {
  it('builds memo and doc comment deep links with safe docs fallback', async () => {
    const notifications = await attachNotificationHrefs(createSupabaseStub(), [
      { id: 'notif-1', reference_type: 'memo', reference_id: 'memo-1' },
      { id: 'notif-2', reference_type: 'doc_comment', reference_id: 'comment-1' },
      { id: 'notif-3', reference_type: 'doc_comment', reference_id: 'missing-comment' },
      { id: 'notif-4', reference_type: 'doc', reference_id: 'doc-2' },
      { id: 'notif-5', reference_type: 'system', reference_id: null },
    ]);

    expect(notifications).toEqual([
      expect.objectContaining({ id: 'notif-1', href: '/memos?id=memo-1' }),
      expect.objectContaining({ id: 'notif-2', href: '/docs?slug=ops-guide&commentId=comment-1' }),
      expect.objectContaining({ id: 'notif-3', href: '/docs' }),
      expect.objectContaining({ id: 'notif-4', href: '/docs?slug=runbook' }),
      expect.objectContaining({ id: 'notif-5', href: null }),
    ]);
  });
});
