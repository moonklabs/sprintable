'use client';

import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { actorRowLabels, memberLookup } from '@/lib/member-display';
import { cn } from '@/lib/utils';
import type { ArtifactVersion, MemberRef, VisualArtifact } from '@/services/canvas';
import { RowName } from '@/components/shared/row-name';

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
  // story #4284 — 이름 없는 구성원 표시(common.memberUnnamed).
  const tc = useTranslations('common');
  const [descOpen, setDescOpen] = useState(false);
  const sorted = [...versions].sort((a, b) => b.version - a.version);
  // [SID:4311 PR 3] 판 줄 작성자 — 같은 이름 서로 다른 작성자 둘이면 «· ID 앞 8자»(작성자 id마다 한 번).
  const authorLabels = actorRowLabels(sorted.map((v) => ({ id: v.created_by, label: memberLookup(memberMap, v.created_by, tc)!.label })));

  return (
    <div className="border-l border-border p-3">
      <p className="mb-3 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">{t('versionLineage')}</p>
      <ul className="space-y-3">
        {sorted.map((v) => {
          const isCurrent = v.version === artifact.current_version;
          const isAnchor = v.version === artifact.anchor_version;
          const isSelected = v.version === selectedVersion;
          // [SID:4286 · 까디르 P1/P4] «—»로 아는 사람(이름 빔)과 모르는 사람을 뭉개던 자리 — 이름 빔 = «이름 없는 구성원», 표에 없음 = «알 수 없는 구성원».
          const authorName = authorLabels.get(v.created_by) ?? memberLookup(memberMap, v.created_by, tc)!.label;
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
                    {/* story #2590(TIER3) — tint 위 계열색 글자는 text-foreground(#2420 규칙). */}
                    {isCurrent ? (
                      <span className="rounded bg-info/10 px-1 py-0.5 text-[9px] font-bold text-foreground">{t('versionCurrentTag')}</span>
                    ) : null}
                    {isAnchor ? (
                      <span className="rounded bg-success/10 px-1 py-0.5 text-[9px] font-bold text-foreground">{t('versionAnchorTag')}</span>
                    ) : null}
                  </p>
                  {/* [SID:4311 PR 3 · 유나 1440 실측] «이름 · 꼬리 · 요약» 한 줄 — 요약 → 이름 순으로 잘리고 꼬리는 늘 보인다(예전 한 덩어리 truncate는
                      13자 이상 이름에서 꼬리가 말줄임에 먹혔다). 요약은 `flex-1`(바탕 0 · 남는 폭만 차지) · 앞 « · »는 줄바꿈 없는 공백. */}
                  <p className="mt-0.5 flex min-w-0 items-baseline text-[11px] text-muted-foreground">
                    <RowName label={authorName} id={v.created_by} />
                    {v.summary ? <span className="min-w-0 flex-1 truncate">{`\u00a0· ${v.summary}`}</span> : null}
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
        descriptionSlot ?? <p className="mt-1.5 text-[11px] text-muted-foreground">{t('descriptionPaneComingSoon')}</p>
      ) : null}
    </div>
  );
}
