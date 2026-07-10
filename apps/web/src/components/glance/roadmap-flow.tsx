import { useTranslations } from 'next-intl';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { RoadmapEpic } from '@/services/glance';

interface RoadmapFlowProps {
  epics: RoadmapEpic[];
  className?: string;
}

/**
 * E-GLANCE §3 로드맵 흐름 — 시퀀스(가로 흐름), 상태 3종(완료·진행·예정). 주어=프로젝트:
 * "6개 중 3번째"(개인/시간 지연 강조 0). 유나 UX handoff §3 권장(가로 타임라인) 채택.
 */
export function RoadmapFlow({ epics, className }: RoadmapFlowProps) {
  const t = useTranslations('glance');
  if (epics.length === 0) return null;

  const activeIndex = epics.findIndex((e) => e.roadmapStatus === 'active');
  const currentIndex = activeIndex >= 0 ? activeIndex : epics.length - 1;

  return (
    <div className={className}>
      <div className="flex flex-wrap items-center gap-x-1 gap-y-2">
        {epics.map((e, i) => (
          <div key={e.id} className="flex items-center gap-1">
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium',
                e.roadmapStatus === 'done' && 'border-success/30 bg-success/10 text-success',
                e.roadmapStatus === 'active' && 'border-info/40 bg-info/10 text-info',
                e.roadmapStatus === 'upcoming' && 'border-border bg-muted/30 text-muted-foreground',
              )}
            >
              {e.roadmapStatus === 'done' ? <Check className="size-3" aria-hidden="true" /> : null}
              {e.roadmapStatus === 'active' ? <span className="size-1.5 rounded-full bg-info" aria-hidden="true" /> : null}
              {e.title}
              {i === currentIndex ? <span className="ml-0.5 text-[9px] opacity-70">{t('currentMarker')}</span> : null}
            </span>
            {i < epics.length - 1 ? <span className="text-muted-foreground/40" aria-hidden="true">─</span> : null}
          </div>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">
        {t('roadmapSummary', { position: currentIndex + 1, total: epics.length })}
      </p>
    </div>
  );
}
