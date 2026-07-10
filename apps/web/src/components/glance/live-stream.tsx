import { useTranslations } from 'next-intl';
import type { BeActivityLogItem } from '@/services/glance';

interface LiveStreamProps {
  events: BeActivityLogItem[];
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
 * props에 안 실려 옴, glance.ts filterMilestoneEvents가 actor 필드를 걷어냄). 시간 표시도
 * 생략 — "N분째" 류 지연 낙인 리스크를 원천 차단(§8 "시간 강조 0").
 */
export function LiveStream({ events, className }: LiveStreamProps) {
  const t = useTranslations('glance');
  if (events.length === 0) {
    return <p className="py-2 text-[11px] text-muted-foreground">{t('liveStreamEmpty')}</p>;
  }

  return (
    <ul className={className}>
      {events.map((e) => (
        <li key={e.id} className="flex items-center gap-2 py-1 text-[11px]">
          <span className="size-1.5 shrink-0 rounded-full bg-info/60" aria-hidden="true" />
          <span className="text-foreground">{eventLabel(e.action, e.entity_type, e.entity_title, t)}</span>
        </li>
      ))}
    </ul>
  );
}
