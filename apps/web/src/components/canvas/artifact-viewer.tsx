'use client';

import { useState } from 'react';
import { Check, Download, MessageCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { ArtifactStage } from './artifact-stage';
import { ArtifactVersionRail } from './artifact-version-rail';
import type { ArtifactVersion, MemberRef, VisualArtifact } from '@/services/canvas';

interface ArtifactViewerProps {
  artifact: VisualArtifact;
  versions: ArtifactVersion[];
  memberMap?: Record<string, MemberRef>;
  /** mock 목적 — 실 코멘트(C2) 착지 전까지 헤더 카운트 표시용. */
  commentCount?: number;
  className?: string;
}

/**
 * E-CANVAS C1-S4 — Lv1 artifact 뷰어. 유나 핸드오프(`e-canvas-trust-surface-handoff` §3) 계약.
 * BE(`visual_artifact`/`artifact_version`, 디디 C1-S3) 미착지 — 이 컴포넌트는 props로 데이터를
 * 받는 순수 뷰라 실 API 착지 시 fetch 래퍼만 새로 감싸면 됨(컴포넌트 자체는 안 바뀜).
 */
export function ArtifactViewer({ artifact, versions, memberMap = {}, commentCount = 0, className }: ArtifactViewerProps) {
  const t = useTranslations('canvas');
  const [selectedVersion, setSelectedVersion] = useState(artifact.current_version);
  const activeVersion = versions.find((v) => v.version === selectedVersion) ?? versions[0];

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
          <span className="ml-auto flex items-center gap-3 text-muted-foreground">
            <span title={t('exportComingSoon')} className="flex items-center gap-1 text-xs opacity-50">
              <Download className="h-3.5 w-3.5" aria-hidden />
            </span>
            <span title={t('commentsComingSoon')} className="flex items-center gap-1 text-xs opacity-50">
              <MessageCircle className="h-3.5 w-3.5" aria-hidden />
              {commentCount > 0 ? commentCount : null}
            </span>
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-[1fr_232px]">
          <div className="bg-muted/20 p-4">
            {activeVersion ? (
              <ArtifactStage format={artifact.format} content={activeVersion.content} title={artifact.title} />
            ) : null}
          </div>
          <ArtifactVersionRail
            artifact={artifact}
            versions={versions}
            selectedVersion={selectedVersion}
            onSelectVersion={setSelectedVersion}
            memberMap={memberMap}
          />
        </div>
      </div>
    </div>
  );
}
