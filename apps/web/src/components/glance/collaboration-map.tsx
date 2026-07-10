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
 * 참여 0인 에픽은 빈 슬롯 우아(§9) — 결핍 표시 아님.
 */
export function CollaborationMap({ roadmap, collaboration, className }: CollaborationMapProps) {
  const t = useTranslations('glance');
  const titleById = new Map(roadmap.map((r) => [r.id, r.title]));
  const withPeople = collaboration.filter((c) => c.collaborators.length > 0);

  if (withPeople.length === 0) {
    return <p className="py-2 text-[11px] text-muted-foreground">{t('collaborationEmpty')}</p>;
  }

  return (
    <div className={className}>
      <ul className="space-y-2.5">
        {withPeople.map((c) => (
          <li key={c.epicId} className="flex items-center gap-2.5">
            <span className="w-24 shrink-0 truncate text-[11px] font-medium text-foreground">
              {titleById.get(c.epicId) ?? c.epicId}
            </span>
            <div className="flex -space-x-1.5">
              {c.collaborators.map((p) => (
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
          </li>
        ))}
      </ul>
    </div>
  );
}
