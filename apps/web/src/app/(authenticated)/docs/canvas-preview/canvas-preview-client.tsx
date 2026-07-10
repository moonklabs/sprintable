'use client';

import { useState } from 'react';
import { ArtifactViewer } from '@/components/canvas/artifact-viewer';
import { CommentThreadCard } from '@/components/canvas/comment-thread-card';
import { MOCK_ARTIFACT, MOCK_VERSIONS, MOCK_MEMBERS } from '@/services/canvas';
import { MOCK_THREADS, MOCK_DESCRIPTIONS, type CommentThread } from '@/services/canvas-comments';

/**
 * E-CANVAS C1/C2 내부 프리뷰(client) — `docs/design-tokens`와 동일한 "라이브 dev QA용
 * 인증된 내부 라우트" 패턴. resolve/reply는 로컬 mock 상태로만 동작(BE `comment`/
 * `activity_event` 계약 미착지) — 디자인 가디언이 상태 전이를 눈으로 확인하는 용도.
 */
export function CanvasPreviewClient() {
  const [threads, setThreads] = useState<CommentThread[]>(MOCK_THREADS);

  const handleResolve = (threadId: string) => {
    setThreads((prev) => prev.map((t) => (
      t.id === threadId ? { ...t, rollup: 'resolved', resolved_by: 'm1', resolved_at: new Date().toISOString() } : t
    )));
  };

  const handleReply = (threadId: string, body: string) => {
    setThreads((prev) => prev.map((t) => (
      t.id === threadId
        ? {
            ...t,
            rollup: t.rollup === 'open' ? 'in_progress' : t.rollup,
            comments: [...t.comments, { id: `local-${t.comments.length}`, author_id: 'm1', body, created_at: new Date().toISOString() }],
            recipients: t.recipients.map((r) => (r.member_id === 'm1' ? { ...r, state: 'responded' } : r)),
          }
        : t
    )));
  };

  return (
    <div className="mx-auto max-w-2xl space-y-8 p-6">
      <div>
        <h1 className="text-lg font-semibold text-foreground">E-CANVAS C1/C2 — Artifact Viewer 프리뷰</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          mock 데이터(BE 계약 미착지) · 스테이지의 파란 핀 클릭 → description pane 전환 · 아래 카드에서 답글/해결 시연
        </p>
      </div>

      <ArtifactViewer
        artifact={MOCK_ARTIFACT}
        versions={MOCK_VERSIONS}
        memberMap={MOCK_MEMBERS}
        threads={threads}
        descriptions={MOCK_DESCRIPTIONS}
      />

      <div className="space-y-3">
        <h2 className="text-xs font-bold uppercase tracking-wide text-muted-foreground">C2 — 코멘트 스레드(전파 상태 머신)</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {threads.map((thread) => (
            <CommentThreadCard
              key={thread.id}
              thread={thread}
              memberMap={MOCK_MEMBERS}
              onResolve={handleResolve}
              onReply={handleReply}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
