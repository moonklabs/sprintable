
import { describe, expect, it, vi } from 'vitest';
import { attachNotificationHrefs } from './notification-navigation';

function createDbStub() {
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
  } as any;
}

describe('attachNotificationHrefs', () => {
  it('builds memo and doc comment deep links with safe docs fallback', async () => {
    const notifications = await attachNotificationHrefs(createDbStub(), [
      { id: 'notif-1', reference_type: 'memo', reference_id: 'memo-1' },
      { id: 'notif-2', reference_type: 'doc_comment', reference_id: 'comment-1' },
      { id: 'notif-3', reference_type: 'doc_comment', reference_id: 'missing-comment' },
      { id: 'notif-4', reference_type: 'doc', reference_id: 'doc-2' },
      { id: 'notif-5', reference_type: 'system', reference_id: null },
    ]);

    expect(notifications).toEqual([
      expect.objectContaining({ id: 'notif-1', href: '/memos?id=memo-1' }),
      expect.objectContaining({ id: 'notif-2', href: '/docs/ops-guide?commentId=comment-1' }),
      expect.objectContaining({ id: 'notif-3', href: '/docs' }),
      expect.objectContaining({ id: 'notif-4', href: '/docs/runbook' }),
      expect.objectContaining({ id: 'notif-5', href: null }),
    ]);
  });

  it('builds board deep links for task/story and a bare sprints link (story a539c649 S3d 발견 버그 회귀가드)', async () => {
    // '/boards'(오탈자·복수형)+task_id 누락으로 task 알림 클릭이 항상 무효였다(존재하지 않는
    // 라우트로 이동+참조 ID 자체가 안 실림) — notification-bell.tsx getEntityHref와 동형으로 정정.
    const notifications = await attachNotificationHrefs(createDbStub(), [
      { id: 'notif-6', reference_type: 'task', reference_id: 'task-1' },
      { id: 'notif-7', reference_type: 'sprint', reference_id: 'sprint-1' },
      { id: 'notif-8', reference_type: 'story', reference_id: 'story-1' },
    ]);

    expect(notifications).toEqual([
      expect.objectContaining({ id: 'notif-6', href: '/board?task_id=task-1' }),
      expect.objectContaining({ id: 'notif-7', href: '/sprints' }),
      expect.objectContaining({ id: 'notif-8', href: '/board?story=story-1' }),
    ]);
  });
});
