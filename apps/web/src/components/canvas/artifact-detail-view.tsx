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
 * story #2725(후속 착지) — 당시엔 "새 좌표 코멘트를 처음부터 남기는" UI가 FE 어디에도 없었다
 * (`ArtifactViewer`의 `commentsComingSoon`은 미착지 트랙의 자리표시자였음). 이제
 * `onCreateThread`(핀 추가 모드→캔버스 픽→작성)로 착지 — standalone 표면에서도 동형(아래
 * `handleCreateThread`).
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

  /** story #2725 — 새 좌표 스레드 생성. artifact-section.tsx의 handleCreateThread와 동형(같은
   * CREATE 엔드포인트 재사용, BE 신규 0). */
  async function handleCreateThread(nodes: ArtifactNode[], anchorXPercent: number, anchorYPercent: number, body: string) {
    await fetchJson(`/api/visual-artifacts/${artifactId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: body, anchor_x: anchorXPercent, anchor_y: anchorYPercent }),
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
        onCreateThread={(x, y, body) => void handleCreateThread(nodes, x, y, body)}
        pendingCanonicalizeVersion={pendingCanonicalizeVersion}
        onProposeCanonical={(versionNumber) => void handleProposeCanonical(versionNumber)}
      />
    </div>
  );
}
