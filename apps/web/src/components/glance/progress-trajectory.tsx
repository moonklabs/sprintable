import { useTranslations } from 'next-intl';
import { derivePhrase, type RoadmapEpic } from '@/services/glance';

interface ProgressTrajectoryProps {
  epic: RoadmapEpic;
  className?: string;
}

/**
 * E-GLANCE §4 현재 위치 — 신뢰 형성 궤적. 정성 언어 우선(§4 "%숫자 강박 아님")·%는 보조.
 * 0/0(아직 스토리 없음)은 결핍 아닌 "시작 전" calm 상태(§9).
 */
export function ProgressTrajectory({ epic, className }: ProgressTrajectoryProps) {
  const t = useTranslations('glance');
  const phrase = derivePhrase(epic.completionPct, epic.total);
  const width = Math.min(100, Math.max(0, epic.completionPct));

  return (
    <div className={className}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold text-foreground">{epic.title}</span>
        <span className="text-[11px] text-muted-foreground">{t(`phrase.${phrase}`)}</span>
      </div>
      <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-muted/50">
        <div className="h-full rounded-full bg-info transition-all" style={{ width: `${width}%` }} />
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">
        {epic.total === 0 ? t('progressNoStories') : t('progressDetail', { done: epic.done, total: epic.total })}
      </p>
    </div>
  );
}
