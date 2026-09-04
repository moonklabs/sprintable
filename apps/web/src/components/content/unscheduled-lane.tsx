import { useTranslations } from 'next-intl';
import { ChannelPostCard } from '@/components/content/channel-post-card';
import type { ChannelPostCalendarItem } from '@/components/content/use-channel-post-calendar-data';

// story #3422(doc §11-1) — 「날짜 미정」 레인. 격자에 놓을 날짜가 없는 초안(scheduled_at
// null·게이트 자체가 없는 순수 초안 포함, BE #3423가 이 둘을 같은 unscheduled=true로
// 묶어 준다)이 "없는 것"으로 보이면 안 된다는 설계 규율 그대로.
export interface UnscheduledLaneProps {
  items: ChannelPostCalendarItem[];
  displayTimezone: string;
}

export function UnscheduledLane({ items, displayTimezone }: UnscheduledLaneProps) {
  const t = useTranslations('content');
  // 빈 레인은 아예 안 그린다(§11-1 "빈 레인이 상시로 자리를 먹으면 격자가 좁아진다") —
  // null을 렌더해 부모가 gap 등으로 자리를 안 먹게 한다.
  if (items.length === 0) return null;
  return (
    <section aria-label={t('channelPostsCalendarUnscheduledLaneLabel')} data-testid="channel-post-unscheduled-lane" className="space-y-2 rounded-md border border-border p-3">
      <h2 className="text-sm font-medium text-foreground">
        {t('channelPostsCalendarUnscheduledLaneTitle', { count: items.length })}
      </h2>
      <div className="flex flex-wrap gap-2">
        {items.map((item) => (
          <div key={item.draft_id} className="w-56">
            <ChannelPostCard item={item} displayTimezone={displayTimezone} />
          </div>
        ))}
      </div>
    </section>
  );
}
