import { useTranslations } from 'next-intl';
import { deriveVagueRecency, type BeActivityLogItem } from '@/services/glance';

interface LiveStreamProps {
  events: BeActivityLogItem[];
  /** 기준 시각(ms) — 렌더 中 Date.now() 직접 호출은 impure(react-hooks/purity)라 호출부
   * (GlanceBoard, fetch 완료 시각)에서 계산해 내려받는다. */
  now: number;
  className?: string;
}

function eventLabel(
  action: string,
  entityType: string | null,
  entityTitle: string | null,
  t: ReturnType<typeof useTranslations<'glance'>>,
): string {
  const entity = entityTitle ? `"${entityTitle.slice(0, 30)}"` : (entityType ?? '');
  switch (action) {
    case 'story.status_changed': return t('eventStoryStatus', { entity });
    case 'story.created': return t('eventStoryCreated', { entity });
    case 'agent_run.completed': return t('eventRunCompleted', { entity });
    case 'agent_run.failed': return t('eventRunFailed', { entity });
    case 'sprint.started': return t('eventSprintStarted', { entity });
    case 'sprint.closed': return t('eventSprintClosed', { entity });
    case 'doc.created': return t('eventDocCreated', { entity });
    default: {
      const label = action.replace(/[._]/g, ' ');
      return entity ? `${label} — ${entity}` : label;
    }
  }
}

/**
 * E-GLANCE §6 생동 스트림 — "누가 주어인가" 리트머스: 이벤트가 주어(액터 정보는 애초에
 * props에 안 실려 옴, glance.ts filterMilestoneEvents가 actor 필드를 걷어냄). 시간은 목업
 * §④ 그대로 "방금"/"조금 전"/"오늘" 같은 성긴 버킷만(분 단위 정밀 경과 표시 0 — §8 "지연
 * 강조 0" 리트머스 유지, 완전 생략 대신 목업 시각 디테일 보강).
 */
export function LiveStream({ events, now, className }: LiveStreamProps) {
  const t = useTranslations('glance');
  if (events.length === 0) {
    return <p className="py-2 text-[11px] text-muted-foreground">{t('liveStreamEmpty')}</p>;
  }

  return (
    <ul className={className}>
      {events.map((e) => (
        <li key={e.id} className="flex items-center gap-2 py-1 text-[11px]">
          <span className="size-1.5 shrink-0 rounded-full bg-info/60" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-foreground">{eventLabel(e.action, e.entity_type, e.entity_title, t)}</span>
          <span className="shrink-0 text-[10px] text-muted-foreground/70">
            {t(`recency.${deriveVagueRecency(new Date(e.created_at).getTime(), now)}`)}
          </span>
        </li>
      ))}
    </ul>
  );
}
