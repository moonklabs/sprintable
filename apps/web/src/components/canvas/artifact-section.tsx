'use client';

import { useEffect, useState } from 'react';
import { ArtifactViewer } from './artifact-viewer';
import { ArtifactEditor } from './artifact-editor';
import {
  adaptArtifactDetail, editArtifact, type ArtifactVersion, type BeArtifactVersionSummary, type MemberRef,
  type VisualArtifact, type BeVisualArtifactDetail, type BeVisualArtifactSummary,
} from '@/services/canvas';
import { adaptComments, type BeArtifactComment, type CommentThread } from '@/services/canvas-comments';
import { derivePendingCanonicalizeVersion, type CanonicalizeGateLookup } from '@/services/canvas-canonicalize';
import { deriveNodeOperations, type ArtifactNode } from '@/services/canvas-nodes';

interface ArtifactSectionProps {
  storyId: string;
  memberMap?: Record<string, MemberRef>;
  className?: string;
}

interface ArtifactItem {
  artifact: VisualArtifact;
  versions: ArtifactVersion[];
  threads: CommentThread[];
  nodes: ArtifactNode[];
  pendingCanonicalizeVersion: number | null;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(url, init);
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: T };
    return json.data ?? null;
  } catch {
    return null;
  }
}

async function loadArtifactThreads(artifactId: string, nodes: ArtifactNode[]): Promise<CommentThread[]> {
  const [comments, versionSummaries] = await Promise.all([
    fetchJson<BeArtifactComment[]>(`/api/visual-artifacts/${artifactId}/comments`),
    fetchJson<BeArtifactVersionSummary[]>(`/api/visual-artifacts/${artifactId}/versions`),
  ]);
  return adaptComments(comments ?? [], nodes, versionSummaries ?? []);
}

/** GET /api/gates는 BE list_gates(response_model=list[...])를 그대로 pass-through — {data} 봉투가
 * 없다(_ok() 미경유). fetchJson과 별개 helper로 raw 배열을 직접 받는다(gate-inbox.tsx와 동일 관례). */
async function loadPendingCanonicalizeVersion(artifactId: string): Promise<number | null> {
  try {
    const res = await fetch(`/api/gates?work_item_id=${artifactId}&status=pending`);
    const gates = res.ok ? (await res.json()) as CanonicalizeGateLookup[] : [];
    return derivePendingCanonicalizeVersion(gates);
  } catch {
    return null;
  }
}

/**
 * E-CANVAS AC2(스토리 상세 첨부) — 실 데이터 attachment point. C1(artifact/version)·
 * C2(comments)·C3(source_comment_id 결과 연결)를 한 컴포넌트에서 병합 — 각자 실 엔드포인트가
 * 있으니 신규 BE 0(2026-07-11 그라운딩). 404/빈 목록은 "첨부 없음"과 동일 취급, mock 폴백 0
 * (선생님 slop 지적 반영 원칙 계승).
 */
export function ArtifactSection({ storyId, memberMap = {}, className }: ArtifactSectionProps) {
  const [items, setItems] = useState<ArtifactItem[]>([]);
  // C3-S7 휴먼 딸깍 편집 — 어느 artifact가 편집 모드인지(tree만 진입·viewer가 게이트). 커밋 성공
  // 후 종료해 fresh 재로드(BE가 버전마다 node.id 리매핑하므로 stale id 재사용 원천 차단).
  const [editingArtifactId, setEditingArtifactId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const artifacts = await fetchJson<BeVisualArtifactSummary[]>(`/api/visual-artifacts?story_id=${storyId}`) ?? [];
        if (artifacts.length === 0) return;

        const resolved = await Promise.all(artifacts.map(async (a): Promise<ArtifactItem | null> => {
          const detail = await fetchJson<BeVisualArtifactDetail>(`/api/visual-artifacts/${a.id}`);
          if (!detail) return null;
          const { artifact, versions } = adaptArtifactDetail(detail);
          const [threads, pendingCanonicalizeVersion] = await Promise.all([
            loadArtifactThreads(a.id, detail.nodes),
            loadPendingCanonicalizeVersion(a.id),
          ]);

          return { artifact, versions, threads, nodes: detail.nodes, pendingCanonicalizeVersion };
        }));

        if (!cancelled) setItems(resolved.filter((d): d is ArtifactItem => d !== null));
      } catch {
        // 네트워크 예외도 "첨부 없음"과 동일 취급 — 스토리 상세 화면 자체를 깨뜨리지 않는다.
      }
    })();
    return () => { cancelled = true; };
  }, [storyId]);

  async function refreshThreads(artifactId: string, nodes: ArtifactNode[]) {
    const threads = await loadArtifactThreads(artifactId, nodes);
    setItems((cur) => cur.map((it) => (it.artifact.id === artifactId ? { ...it, threads } : it)));
  }

  async function handleResolve(artifactId: string, nodes: ArtifactNode[], threadId: string) {
    await fetchJson(`/api/visual-artifacts/${artifactId}/comments/${threadId}/resolve`, { method: 'POST' });
    await refreshThreads(artifactId, nodes);
  }

  async function handleReply(artifactId: string, nodes: ArtifactNode[], threadId: string, body: string) {
    await fetchJson(`/api/visual-artifacts/${artifactId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: body, parent_id: threadId }),
    });
    await refreshThreads(artifactId, nodes);
  }

  async function handleProposeCanonical(artifactId: string, versionNumber: number) {
    await fetchJson(`/api/visual-artifacts/${artifactId}/versions/${versionNumber}/canonicalize`, { method: 'POST' });
    const pendingCanonicalizeVersion = await loadPendingCanonicalizeVersion(artifactId);
    setItems((cur) => cur.map((it) => (it.artifact.id === artifactId ? { ...it, pendingCanonicalizeVersion } : it)));
  }

  /**
   * 딸깍 편집 커밋 — 편집기의 최종 노드셋을 baseline(현 버전 노드)과 diff해 operations로 유도,
   * MCP와 동일한 `/edit` 엔드포인트로 커밋(새 버전). 성공 시 새 detail로 아이템을 갱신하고 편집
   * 모드를 종료(fresh 재로드·정본 불변). 변경 0이면 조용히 종료, 실패면 편집 유지(원인 로깅).
   */
  async function handleCommitEdit(item: ArtifactItem, committedNodes: ArtifactNode[], summary: string) {
    const operations = deriveNodeOperations(item.nodes, committedNodes);
    if (operations.length === 0) { setEditingArtifactId(null); return; }
    const detail = await editArtifact(item.artifact.id, operations, summary);
    if (!detail) {
      // 빈 catch 금지 계열 — 커밋 실패를 삼키지 않고 로깅, 편집 모드 유지(사용자 재시도 가능).
      console.error('[canvas-edit] artifact edit commit failed', item.artifact.id);
      return;
    }
    const { artifact, versions } = adaptArtifactDetail(detail);
    const [threads, pendingCanonicalizeVersion] = await Promise.all([
      loadArtifactThreads(artifact.id, detail.nodes),
      loadPendingCanonicalizeVersion(artifact.id),
    ]);
    setItems((cur) => cur.map((it) => (it.artifact.id === artifact.id
      ? { artifact, versions, threads, nodes: detail.nodes, pendingCanonicalizeVersion }
      : it)));
    setEditingArtifactId(null);
  }

  if (items.length === 0) return null;

  return (
    <div className={className}>
      {items.map((item) => {
        const { artifact, versions, threads, nodes, pendingCanonicalizeVersion } = item;
        // 편집 모드 = 뷰어 대신 편집기(같은 자리). tree 진입은 viewer의 onEnterEdit 게이트가 보장.
        if (editingArtifactId === artifact.id) {
          return (
            <ArtifactEditor
              key={artifact.id}
              title={artifact.title}
              initialNodes={nodes}
              onCommit={(committed, summary) => void handleCommitEdit(item, committed, summary)}
              onDone={() => setEditingArtifactId(null)}
            />
          );
        }
        return (
          <ArtifactViewer
            key={artifact.id}
            artifact={artifact}
            versions={versions}
            memberMap={memberMap}
            threads={threads}
            nodes={nodes}
            onEnterEdit={() => setEditingArtifactId(artifact.id)}
            onResolveThread={(threadId) => void handleResolve(artifact.id, nodes, threadId)}
            onReplyThread={(threadId, body) => void handleReply(artifact.id, nodes, threadId, body)}
            pendingCanonicalizeVersion={pendingCanonicalizeVersion}
            onProposeCanonical={(versionNumber) => void handleProposeCanonical(artifact.id, versionNumber)}
          />
        );
      })}
    </div>
  );
}
