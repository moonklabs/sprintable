'use client';

import { useState } from 'react';
import { ArtifactViewer } from '@/components/canvas/artifact-viewer';
import { CommentThreadCard } from '@/components/canvas/comment-thread-card';
import { ArtifactEditor } from '@/components/canvas/artifact-editor';
import { ConcurrencyPrompt } from '@/components/canvas/concurrency-prompt';
import { MOCK_ARTIFACT, MOCK_VERSIONS, MOCK_MEMBERS, MOCK_EDITABLE_ARTIFACT } from '@/services/canvas';
import { MOCK_THREADS, MOCK_DESCRIPTIONS, type CommentThread } from '@/services/canvas-comments';
import { MOCK_EDITABLE_NODES, resolveNodeTree, type ArtifactNode } from '@/services/canvas-nodes';

/**
 * E-CANVAS C1/C2/C3 내부 프리뷰(client) — `docs/design-tokens`와 동일한 "라이브 dev QA용
 * 인증된 내부 라우트" 패턴. resolve/reply/commit은 로컬 mock 상태로만 동작(BE 계약 미착지)
 * — 디자인 가디언이 상태 전이를 눈으로 확인하는 용도.
 */
export function CanvasPreviewClient() {
  const [threads, setThreads] = useState<CommentThread[]>(MOCK_THREADS);
  const [editing, setEditing] = useState(false);
  const [committedNodes, setCommittedNodes] = useState<ArtifactNode[]>(MOCK_EDITABLE_NODES);
  const [showConcurrency, setShowConcurrency] = useState(false);

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

  const handleCommit = (nodes: ArtifactNode[]) => {
    setCommittedNodes(nodes);
    setShowConcurrency(true); // 데모용 — 실제로는 다른 저자의 커밋 도착 시에만 뜬다.
  };

  return (
    <div className="mx-auto max-w-2xl space-y-8 p-6">
      <div>
        <h1 className="text-lg font-semibold text-foreground">E-CANVAS C1/C2/C3 — Artifact 프리뷰</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          mock 데이터(BE 계약 미착지) · 파란 핀 클릭 → description pane · 아래 카드 답글/해결 · 편집용 artifact는 &quot;편집&quot; 버튼으로 Lv3 진입
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

      <div className="space-y-3">
        <h2 className="text-xs font-bold uppercase tracking-wide text-muted-foreground">C3 — 딸깍 편집(양방향 동일 객체)</h2>
        {editing ? (
          <div className="space-y-3">
            <ArtifactEditor
              title={MOCK_EDITABLE_ARTIFACT.title}
              initialNodes={committedNodes}
              onCommit={handleCommit}
              onDone={() => setEditing(false)}
            />
            {showConcurrency ? (
              <ConcurrencyPrompt
                authorName={MOCK_MEMBERS['m3']!.name}
                version={2}
                onView={() => setShowConcurrency(false)}
                onMergeOver={() => setShowConcurrency(false)}
              />
            ) : null}
          </div>
        ) : (
          <ArtifactViewer
            artifact={MOCK_EDITABLE_ARTIFACT}
            versions={[{
              id: 'ev1', artifact_id: MOCK_EDITABLE_ARTIFACT.id, version: 1,
              // read-only stage(ArtifactStage)는 nested-children tree JSON을 기대 — flat
              // ArtifactNode[]를 resolveNodeTree로 변환(C1/C3가 이 어댑터를 공유하는 지점).
              content: JSON.stringify(resolveNodeTree(committedNodes)),
              created_by: 'm1', summary: null, created_at: new Date().toISOString(),
            }]}
            memberMap={MOCK_MEMBERS}
            onEnterEdit={() => setEditing(true)}
          />
        )}
      </div>
    </div>
  );
}
