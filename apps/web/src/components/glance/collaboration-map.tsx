import { useTranslations } from 'next-intl';
import type { EpicCollaboration, RoadmapEpic } from '@/services/glance';

interface CollaborationMapProps {
  roadmap: RoadmapEpic[];
  collaboration: EpicCollaboration[];
  className?: string;
}

/**
 * E-GLANCE §5 참여 협업 지도 — ⭐감시 최고 위험 지점. 절대 금지: 개인별 "N개 완료"·처리량·
 * 순위·기여도 %(§5 하드라인). 아바타 옆 숫자 배지 0 — 오직 "누가 함께 있나"(presence)만.
 * §9 상태 매트릭스 그대로: 참여 0인 에픽도 **행 자체는 남기고** "아직 배정 전"(중립)으로
 * 우아하게 — 목업(§③ light) 실 예시가 E-GLANCE 행을 그렇게 렌더함(행을 통째로 숨기지 않음).
 * 단 아직 손도 안 댄(upcoming) 에픽까지 전부 나열하면 목록이 늘어지니, active/done 에픽만 대상.
 */
export function CollaborationMap({ roadmap, collaboration, className }: CollaborationMapProps) {
  const t = useTranslations('glance');
  const collabByEpic = new Map(collaboration.map((c) => [c.epicId, c.collaborators]));
  const rows = roadmap.filter((e) => e.roadmapStatus !== 'upcoming');

  if (rows.length === 0) {
    return <p className="py-2 text-[11px] text-muted-foreground">{t('collaborationEmpty')}</p>;
  }

  return (
    <div className={className}>
      <ul className="space-y-2.5">
        {rows.map((e) => {
          const collaborators = collabByEpic.get(e.id) ?? [];
          return (
            <li key={e.id} className="flex items-center gap-2.5">
              <span className="w-24 shrink-0 truncate text-[11px] font-medium text-foreground">{e.title}</span>
              {collaborators.length > 0 ? (
                <>
                  <div className="flex -space-x-1.5">
                    {collaborators.map((p) => (
                      <span
                        key={p.id}
                        title={p.name}
                        className="flex size-6 items-center justify-center rounded-full border-2 border-card bg-primary/15 text-[10px] font-semibold text-primary"
                      >
                        {p.name.slice(0, 1)}
                      </span>
                    ))}
                  </div>
                  <span className="text-[11px] text-muted-foreground">{t('collaborationTogether')}</span>
                </>
              ) : (
                <span className="text-[11px] italic text-muted-foreground/70">{t('collaborationEmpty')}</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
