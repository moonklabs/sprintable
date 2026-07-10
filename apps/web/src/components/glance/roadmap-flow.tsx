import { useTranslations } from 'next-intl';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { RoadmapEpic } from '@/services/glance';

interface RoadmapFlowProps {
  epics: RoadmapEpic[];
  className?: string;
}

/**
 * E-GLANCE §3 로드맵 흐름 — 노드+커넥터 타임라인. 시각 SSOT(`e-glance-glance-board-mockup-render`)
 * §① 그대로: 완료 노드는 success 채움+체크, 진행 노드는 info 채움+링 글로우+"● 여기" 마커,
 * 예정 노드는 muted 아웃라인. 커넥터는 완료 구간만 success로 채워져 "여기까지 왔다"를 표현.
 * 주어=프로젝트: "6개 중 3번째"(개인/시간 지연 강조 0).
 */
export function RoadmapFlow({ epics, className }: RoadmapFlowProps) {
  const t = useTranslations('glance');
  if (epics.length === 0) return null;

  const activeIndex = epics.findIndex((e) => e.roadmapStatus === 'active');
  const currentIndex = activeIndex >= 0 ? activeIndex : epics.length - 1;

  return (
    <div className={className}>
      <div className="flex items-start">
        {epics.map((e, i) => (
          <div key={e.id} className="flex flex-1 items-start last:flex-none">
            <div className="flex min-w-0 flex-col items-center">
              <span
                className={cn(
                  'flex size-8 shrink-0 items-center justify-center rounded-full border-2 text-sm font-bold',
                  e.roadmapStatus === 'done' && 'border-success bg-success/10 text-success',
                  e.roadmapStatus === 'active' && 'border-info bg-info/10 text-info ring-4 ring-info/10',
                  e.roadmapStatus === 'upcoming' && 'border-border bg-muted/30 text-muted-foreground',
                )}
              >
                {e.roadmapStatus === 'done' ? <Check className="size-4" aria-hidden="true" /> : null}
                {e.roadmapStatus === 'active' ? <span className="size-2.5 rounded-full bg-info" aria-hidden="true" /> : null}
              </span>
              <span
                className={cn(
                  'mt-2 max-w-[88px] truncate text-center text-[10.5px] font-semibold',
                  e.roadmapStatus === 'upcoming' ? 'text-muted-foreground/70' : 'text-muted-foreground',
                )}
              >
                {e.title}
              </span>
              {i === currentIndex ? <span className="mt-0.5 text-[9px] font-bold text-info">{t('currentMarker')}</span> : null}
            </div>
            {i < epics.length - 1 ? (
              <div className={cn('mt-4 h-0.5 flex-1', e.roadmapStatus === 'done' ? 'bg-success' : 'bg-border')} aria-hidden="true" />
            ) : null}
          </div>
        ))}
      </div>
      <p className="mt-3 text-[11.5px] text-foreground">
        {t.rich('roadmapSummary', {
          position: currentIndex + 1,
          total: epics.length,
          b: (chunks) => <b className="text-info">{chunks}</b>,
        })}
      </p>
    </div>
  );
}
