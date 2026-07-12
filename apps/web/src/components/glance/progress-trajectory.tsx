import { useTranslations } from 'next-intl';
import { derivePhrase, type RoadmapEpic } from '@/services/glance';

interface ProgressTrajectoryProps {
  epic: RoadmapEpic;
  className?: string;
}

/**
 * E-GLANCE §4 현재 위치 — 신뢰 형성 궤적. 시각 SSOT(`e-glance-glance-board-mockup-render`) §②
 * 그대로: 이름·트랙·정성 라벨을 한 줄에(inline row). 정성 언어 우선(§4 "%숫자 강박 아님")·
 * 스토리 수는 보조 문구로만. 0/0(아직 스토리 없음)은 결핍 아닌 "시작 전" calm 상태(§9).
 */
export function ProgressTrajectory({ epic, className }: ProgressTrajectoryProps) {
  const t = useTranslations('glance');
  const phrase = derivePhrase(epic.completionPct, epic.total);
  const width = Math.min(100, Math.max(0, epic.completionPct));

  return (
    <div className={className}>
      <div className="flex items-center gap-3.5">
        <span className="w-24 shrink-0 truncate text-xs font-semibold text-foreground">{epic.title}</span>
        <div className="h-2.5 min-w-0 flex-1 overflow-hidden rounded-full border border-border/60 bg-muted/50">
          <div className="h-full rounded-full bg-info transition-all" style={{ width: `${width}%` }} />
        </div>
        <span className="shrink-0 whitespace-nowrap text-[11.5px] text-muted-foreground">
          <span className="font-semibold text-foreground">{t(`phrase.${phrase}`)}</span>
          {epic.total > 0 ? ` · ${t('progressDetail', { done: epic.done, total: epic.total })}` : null}
        </span>
      </div>
      {epic.total === 0 ? <p className="mt-1.5 text-[11px] text-muted-foreground">{t('progressNoStories')}</p> : null}
    </div>
  );
}
