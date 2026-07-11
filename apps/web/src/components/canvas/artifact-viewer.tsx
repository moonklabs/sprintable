'use client';

import { useRef, useState } from 'react';
import { Check, Clock, Download, MessageCircle, Pencil, Sparkles } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { ArtifactStage } from './artifact-stage';
import { ArtifactVersionRail } from './artifact-version-rail';
import { AnchorPin } from './anchor-pin';
import { CommentThreadCard } from './comment-thread-card';
import { DescriptionPane } from './description-pane';
import { ExportDialog } from './export-dialog';
import type { ArtifactVersion, MemberRef, VisualArtifact } from '@/services/canvas';
import type { ArtifactNode } from '@/services/canvas-nodes';
import type { CommentThread } from '@/services/canvas-comments';

interface ArtifactViewerProps {
  artifact: VisualArtifact;
  versions: ArtifactVersion[];
  memberMap?: Record<string, MemberRef>;
  /** mock 목적 — threads가 없을 때만 쓰이는 폴백 헤더 카운트(C2 착지 전). */
  commentCount?: number;
  /** C2 — 좌표 앵커 스레드는 스테이지에 핀 오버레이. element 앵커는 후속(실 artifact tree
   * 좌표 유도 필요 — 지금은 좌표 앵커만 오버레이). 헤더 아래 스레드 목록 패널도 이 prop으로
   * 렌더(있으면 element/coordinate 앵커 모두 카드로 나열 — 좌표 앵커만 핀 오버레이도 겸함). */
  threads?: CommentThread[];
  /** description pane 소스 — C2-S6 실 컬럼(node.description)을 element 앵커 코멘트가 가리키는
   * 노드에서 직접 조회(mock 시절 별도 DescriptionMap은 폐기 — 실 데이터 그대로 사용). */
  nodes?: ArtifactNode[];
  /** C3 §1 — 뷰어→편집모드 진입점. format='tree'일 때만 노출(html/image는 이 UI로 편집
   * 불가). 정본 버전을 보는 중이면 "새 버전으로 편집" 라벨(정본 계약 보호 — 실제 분기 로직은
   * BE 연동 시, 지금은 라벨만 다르고 동일 콜백). */
  onEnterEdit?: () => void;
  /** C2-S6 실 뮤테이션 — 생략하면 카드는 읽기전용(reply 입력/resolve 버튼이 no-op). */
  onResolveThread?: (threadId: string) => void;
  onReplyThread?: (threadId: string, body: string) => void;
  /** C4-S8 정본화 — 승인은 새 UI 없이 기존 GateInbox가 처리(§1), 여기선 제안만. 선택된
   * 버전에 이미 대기 중인 제안이 있으면 pendingCanonicalizeVersion === selectedVersion. */
  pendingCanonicalizeVersion?: number | null;
  onProposeCanonical?: (versionNumber: number) => void;
  className?: string;
}

/**
 * E-CANVAS C1-S4 — Lv1 artifact 뷰어. 유나 핸드오프(`e-canvas-trust-surface-handoff` §3) 계약.
 * BE(`visual_artifact`/`artifact_version`, 디디 C1-S3) 미착지 — 이 컴포넌트는 props로 데이터를
 * 받는 순수 뷰라 실 API 착지 시 fetch 래퍼만 새로 감싸면 됨(컴포넌트 자체는 안 바뀜).
 */
export function ArtifactViewer({
  artifact, versions, memberMap = {}, commentCount = 0, threads, nodes = [], onEnterEdit, onResolveThread, onReplyThread,
  pendingCanonicalizeVersion, onProposeCanonical, className,
}: ArtifactViewerProps) {
  const t = useTranslations('canvas');
  const [selectedVersion, setSelectedVersion] = useState(artifact.current_version);
  const isViewingAnchor = selectedVersion === artifact.anchor_version;
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const captureTargetRef = useRef<HTMLDivElement>(null);
  const activeVersion = versions.find((v) => v.version === selectedVersion) ?? versions[0];
  const selectedThread = threads?.find((th) => th.id === selectedThreadId) ?? null;
  const selectedThreadDescription = selectedThread?.anchor.element_id
    ? (nodes.find((n) => n.id === selectedThread.anchor.element_id)?.description ?? null)
    : null;
  const openThreadCount = threads?.filter((th) => th.rollup !== 'resolved').length ?? 0;

  return (
    <div className={className}>
      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
          <span className="truncate text-sm font-semibold text-foreground">{artifact.title}</span>
          <span className="rounded-md border border-border bg-muted px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
            {artifact.format}
          </span>
          <select
            value={selectedVersion}
            onChange={(e) => setSelectedVersion(Number(e.target.value))}
            className="rounded-md border border-border bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
          >
            {[...versions].sort((a, b) => b.version - a.version).map((v) => (
              <option key={v.id} value={v.version}>v{v.version}</option>
            ))}
          </select>
          {artifact.anchor_version != null ? (
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-success/85">
              <Check className="h-3 w-3" strokeWidth={2.6} aria-hidden />
              {t('anchorBadge', { version: artifact.anchor_version })}
            </span>
          ) : null}
          {/* C4-S8 §1 — 에이전트/사람 모두 제안만, 승인은 GateInbox(인간 전용). 이미 정본이거나
           * 이미 대기 중인 제안이 있으면 제안 버튼을 숨긴다(중복 제안 방지). */}
          {!isViewingAnchor && onProposeCanonical ? (
            pendingCanonicalizeVersion === selectedVersion ? (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
                <Clock className="h-3 w-3" aria-hidden />
                {t('canonicalizePendingBadge')}
              </span>
            ) : (
              <button
                type="button"
                onClick={() => onProposeCanonical(selectedVersion)}
                className="flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[11px] font-semibold text-foreground hover:bg-muted"
              >
                <Sparkles className="h-3 w-3" aria-hidden />
                {t('proposeCanonicalAction')}
              </button>
            )
          ) : null}
          <span className="ml-auto flex items-center gap-3 text-muted-foreground">
            {artifact.format === 'tree' && onEnterEdit ? (
              <button
                type="button"
                onClick={onEnterEdit}
                className="flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[11px] font-semibold text-foreground hover:bg-muted"
              >
                <Pencil className="h-3 w-3" aria-hidden />
                {isViewingAnchor ? t('editAsNewVersionAction') : t('editAction')}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setExportOpen(true)}
              title={t('exportDialogTitle')}
              className="flex items-center gap-1 text-xs hover:text-foreground"
            >
              <Download className="h-3.5 w-3.5" aria-hidden />
            </button>
            <span
              title={threads ? undefined : t('commentsComingSoon')}
              className={`flex items-center gap-1 text-xs ${threads ? '' : 'opacity-50'}`}
            >
              <MessageCircle className="h-3.5 w-3.5" aria-hidden />
              {threads ? (openThreadCount > 0 ? openThreadCount : null) : (commentCount > 0 ? commentCount : null)}
            </span>
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-[1fr_232px]">
          <div ref={captureTargetRef} className="relative bg-muted/20 p-4">
            {activeVersion ? (
              <ArtifactStage format={artifact.format} content={activeVersion.content} title={artifact.title} />
            ) : null}
            {/* C2 §1 — 좌표 앵커 스레드만 오버레이(element 앵커는 실 artifact tree 좌표 유도 필요, 후속). */}
            {threads?.filter((th) => th.anchor.kind === 'coordinate').map((th) => (
              <AnchorPin
                key={th.id}
                number={th.pin_number}
                state={th.rollup === 'resolved' ? 'resolved' : 'open'}
                active={th.id === selectedThreadId}
                onClick={() => setSelectedThreadId((cur) => (cur === th.id ? null : th.id))}
                className="absolute z-10"
                style={{ left: `${th.anchor.x}%`, top: `${th.anchor.y}%` }}
              />
            ))}
          </div>
          <ArtifactVersionRail
            artifact={artifact}
            versions={versions}
            selectedVersion={selectedVersion}
            onSelectVersion={setSelectedVersion}
            memberMap={memberMap}
            descriptionSlot={threads ? (
              <DescriptionPane
                description={selectedThreadDescription}
                elementLabel={selectedThread?.element_label}
                className="mt-1.5"
              />
            ) : undefined}
          />
        </div>

        {threads && threads.length > 0 ? (
          <div className="space-y-2 border-t border-border bg-muted/10 p-3">
            {threads.map((th) => (
              <CommentThreadCard
                key={th.id}
                thread={th}
                memberMap={memberMap}
                active={th.id === selectedThreadId}
                onSelectPin={(id) => setSelectedThreadId((cur) => (cur === id ? null : id))}
                onResolve={onResolveThread}
                onReply={onReplyThread}
              />
            ))}
          </div>
        ) : null}
      </div>
      <ExportDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        artifactId={artifact.id}
        versionNumber={selectedVersion}
        captureTargetRef={captureTargetRef}
        artifactFormat={artifact.format}
      />
    </div>
  );
}
