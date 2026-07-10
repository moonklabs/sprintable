'use client';

import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import type { ArtifactVersion, MemberRef, VisualArtifact } from '@/services/canvas';

interface ArtifactVersionRailProps {
  artifact: VisualArtifact;
  versions: ArtifactVersion[];
  selectedVersion: number;
  onSelectVersion: (version: number) => void;
  memberMap?: Record<string, MemberRef>;
  /** C2 착지 후 슬롯 — 넘기면 "coming soon" 대신 이 노드(보통 `<DescriptionPane/>`)를 렌더.
   * ArtifactVersionRail 자체는 C2 타입을 몰라도 되게 순수 슬롯으로 받는다. */
  descriptionSlot?: React.ReactNode;
}

/**
 * E-CANVAS C1 Lv1 — 버전 lineage 레일. 각 엔트리 = 변경자·변경 이유(의미 단위)만.
 * raw 편집 나열 금지(핸드오프 §6 감시 게이트) — 여기 보이는 게 실제 저장된 커밋 단위 전부다.
 */
export function ArtifactVersionRail({ artifact, versions, selectedVersion, onSelectVersion, memberMap = {}, descriptionSlot }: ArtifactVersionRailProps) {
  const t = useTranslations('canvas');
  const [descOpen, setDescOpen] = useState(false);
  const sorted = [...versions].sort((a, b) => b.version - a.version);

  return (
    <div className="border-l border-border p-3">
      <p className="mb-3 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">{t('versionLineage')}</p>
      <ul className="space-y-3">
        {sorted.map((v) => {
          const isCurrent = v.version === artifact.current_version;
          const isAnchor = v.version === artifact.anchor_version;
          const isSelected = v.version === selectedVersion;
          const authorName = memberMap[v.created_by]?.name ?? '—';
          return (
            <li key={v.id}>
              <button
                type="button"
                onClick={() => onSelectVersion(v.version)}
                className={cn(
                  'flex w-full items-start gap-2 rounded-md p-1 text-left transition-colors hover:bg-muted/40',
                  isSelected && 'bg-muted/60',
                )}
              >
                <span
                  className={cn(
                    'mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full border-2',
                    isAnchor ? 'border-success bg-success/85' : isCurrent ? 'border-info bg-info' : 'border-border bg-background',
                  )}
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                    v{v.version}
                    {isCurrent ? (
                      <span className="rounded bg-info/10 px-1 py-0.5 text-[9px] font-bold text-info">{t('versionCurrentTag')}</span>
                    ) : null}
                    {isAnchor ? (
                      <span className="rounded bg-success/10 px-1 py-0.5 text-[9px] font-bold text-success">{t('versionAnchorTag')}</span>
                    ) : null}
                  </p>
                  <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                    {authorName}{v.summary ? ` · ${v.summary}` : ''}
                  </p>
                </div>
              </button>
            </li>
          );
        })}
      </ul>

      <button
        type="button"
        onClick={() => setDescOpen((v) => !v)}
        className="mt-3 flex w-full items-center gap-1 border-t border-border pt-3 text-left text-[11px] text-muted-foreground hover:text-foreground"
      >
        {t('descriptionPaneToggle')}
        {descOpen ? <ChevronUp className="h-3 w-3" aria-hidden /> : <ChevronDown className="h-3 w-3" aria-hidden />}
      </button>
      {descOpen ? (
        descriptionSlot ?? <p className="mt-1.5 text-[11px] text-muted-foreground/80">{t('descriptionPaneComingSoon')}</p>
      ) : null}
    </div>
  );
}
