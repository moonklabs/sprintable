'use client';

import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';

export interface GalleryTimelineVersion {
  versionNumber: number;
  summary: string | null;
  isAnchor: boolean;
}

interface ArtifactGalleryTimelineProps {
  versions: GalleryTimelineVersion[];
  className?: string;
}

/**
 * 산출물 갤러리 변천사 타임라인(story a15cea4f) — v1→vN 가로 시간축. `ArtifactVersionRail`
 * (스토리 상세 편집 사이드바)과 의도적으로 다른 컴포넌트: 그쪽은 작성자를 보여주는 게 맞는 문맥
 * (인-스토리 협업 이력)이지만, 갤러리는 doc `artifact-gallery-design` §3의 감시 금지 경계가
 * 더 엄격함 — **주어는 산출물/버전의 진화**뿐, 작성자·편집 횟수·경과시간은 렌더 자체가 없다.
 * anchor(정본)=success 톤 노드, 그 외=info 톤 — 빨강 0.
 */
export function ArtifactGalleryTimeline({ versions, className }: ArtifactGalleryTimelineProps) {
  const t = useTranslations('canvas');
  return (
    <div className={cn('flex items-start gap-0 overflow-x-auto', className)}>
      {versions.map((v, i) => {
        const isLast = i === versions.length - 1;
        return (
          <div key={v.versionNumber} className={cn('min-w-0', isLast ? 'flex-none' : 'flex-1 pr-3.5')}>
            <div className="mb-1.5 flex items-center gap-0">
              <span
                className={cn(
                  'h-[11px] w-[11px] shrink-0 rounded-full border-2',
                  v.isAnchor ? 'border-success bg-success' : 'border-info bg-background',
                )}
                aria-hidden="true"
              />
              {!isLast ? <span className="h-0.5 flex-1 bg-border" aria-hidden="true" /> : null}
            </div>
            <p className={cn('text-[11px] font-bold tabular-nums', v.isAnchor ? 'text-success' : 'text-foreground')}>
              v{v.versionNumber}
              {v.isAnchor ? <span className="ml-1 font-medium">{t('versionAnchorTag')}</span> : null}
            </p>
            {v.summary ? <p className="mt-0.5 truncate text-[11.5px] text-muted-foreground">{v.summary}</p> : null}
          </div>
        );
      })}
    </div>
  );
}
