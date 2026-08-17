'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ArtifactViewer } from './artifact-viewer';
import { fetchJson, loadArtifactThreads, loadPendingCanonicalizeVersion } from './artifact-section';
import {
  adaptArtifactDetail, type ArtifactVersion, type VisualArtifact, type BeVisualArtifactDetail,
} from '@/services/canvas';
import type { CommentThread } from '@/services/canvas-comments';
import type { ArtifactNode } from '@/services/canvas-nodes';
import { listSpecPins, type SpecPin } from '@/services/canvas-spec-pins';
import { useSyntheticParentTabHistory } from '@/hooks/use-synthetic-parent-tab-history';

interface DetailItem {
  artifact: VisualArtifact;
  versions: ArtifactVersion[];
  threads: CommentThread[];
  nodes: ArtifactNode[];
  pendingCanonicalizeVersion: number | null;
  specPins: SpecPin[];
}

type DetailState = DetailItem | null | 'not_found';

/**
 * story #2713(결함·발견성·가치) — standalone(story/doc/epic 미연결) 아티팩트의 상세 진입점.
 * `ArtifactSection`(스토리 상세 부착형, storyId 필수)과 갤러리 `ArtifactExpandDialog`(순수
 * 프리뷰, threads 자체를 안 받음) 둘 다 이 자리를 못 채운다 — 이 컴포넌트는 그 둘 사이,
 * 단건 artifactId만으로 `ArtifactSection`과 동형 로더(threads·specPins·canonicalize)를
 * 재사용해 `ArtifactViewer`를 직접 그린다(신규 코멘트/핀 저장 로직 0 — 기존 reply/resolve
 * 엔드포인트 그대로).
 *
 * ⚠️ "새 좌표 코멘트를 처음부터 남기기"(핀 없이 캔버스를 클릭해 새 스레드를 여는 것)는
 * `ArtifactSection`에도 없다 — `onReplyThread`는 항상 기존 threadId(parent_id)에 대한
 * 답글만 만든다(handleReply 구현 확認). 즉 `ArtifactViewer` 헤더의 `commentsComingSoon`은
 * 이 스토리가 되돌릴 수 있는 "남겨진 단순 플래그"가 아니라, 아직 어디에도 안 지어진 별도
 * 트랙(코멘트 최초 작성 UI)의 자리표시자다 — 이번 판은 그 트랙을 새로 짓지 않고 기존 도달성
 * (있는 코멘트 열람 + 기존 스레드에 답글)만 standalone까지 넓힌다.
 */
export function ArtifactDetailView({ artifactId }: { artifactId: string }) {
  const t = useTranslations('canvas');
  useSyntheticParentTabHistory('/more');
  const [state, setState] = useState<DetailState>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const detail = await fetchJson<BeVisualArtifactDetail>(`/api/visual-artifacts/${artifactId}`);
      if (!detail) { if (!cancelled) setState('not_found'); return; }
      const { artifact, versions } = adaptArtifactDetail(detail);
      const [threads, pendingCanonicalizeVersion, specPins] = await Promise.all([
        loadArtifactThreads(artifactId, detail.nodes),
        loadPendingCanonicalizeVersion(artifactId),
        listSpecPins(artifactId),
      ]);
      if (!cancelled) {
        setState({ artifact, versions, threads, nodes: detail.nodes, pendingCanonicalizeVersion, specPins });
      }
    })();
    return () => { cancelled = true; };
  }, [artifactId]);

  async function refreshThreads(nodes: ArtifactNode[]) {
    const threads = await loadArtifactThreads(artifactId, nodes);
    setState((cur) => (cur && cur !== 'not_found' ? { ...cur, threads } : cur));
  }

  async function handleResolve(nodes: ArtifactNode[], threadId: string) {
    await fetchJson(`/api/visual-artifacts/${artifactId}/comments/${threadId}/resolve`, { method: 'POST' });
    await refreshThreads(nodes);
  }

  async function handleReply(nodes: ArtifactNode[], threadId: string, body: string) {
    await fetchJson(`/api/visual-artifacts/${artifactId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: body, parent_id: threadId }),
    });
    await refreshThreads(nodes);
  }

  async function handleProposeCanonical(versionNumber: number) {
    await fetchJson(`/api/visual-artifacts/${artifactId}/versions/${versionNumber}/canonicalize`, { method: 'POST' });
    const pendingCanonicalizeVersion = await loadPendingCanonicalizeVersion(artifactId);
    setState((cur) => (cur && cur !== 'not_found' ? { ...cur, pendingCanonicalizeVersion } : cur));
  }

  if (state === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">{t('detailLoading')}</p>
      </div>
    );
  }

  if (state === 'not_found') {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">{t('detailNotFound')}</p>
      </div>
    );
  }

  const { artifact, versions, threads, nodes, pendingCanonicalizeVersion, specPins } = state;

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 lg:px-8 lg:py-8">
      <Link href=".." className="mb-4 inline-block text-xs font-medium text-muted-foreground hover:text-foreground">
        {t('galleryBackAction')}
      </Link>
      <ArtifactViewer
        artifact={artifact}
        versions={versions}
        threads={threads}
        nodes={nodes}
        specPins={specPins}
        onResolveThread={(threadId) => void handleResolve(nodes, threadId)}
        onReplyThread={(threadId, body) => void handleReply(nodes, threadId, body)}
        pendingCanonicalizeVersion={pendingCanonicalizeVersion}
        onProposeCanonical={(versionNumber) => void handleProposeCanonical(versionNumber)}
      />
    </div>
  );
}
