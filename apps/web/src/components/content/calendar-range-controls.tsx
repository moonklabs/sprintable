import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';

// story #3422(doc §11 T8) — 주 단위 이동(월 단위는 후속, 화면 자체는 range를 그대로
// 받아 그리므로 이 컴포넌트가 range 계산 방식을 늘려도 CalendarGrid는 안 바뀐다).
// 범위 계산은 순수 함수로 분리해 이 컴포넌트가 상태를 갖지 않는다(부모가 range를
// 소유 — useChannelPostCalendarData가 바로 그 range를 받는 훅이라 여기서 관리하면
// 두 곳이 상태를 나눠 갖게 된다).
export interface CalendarRangeControlsProps {
  range: { from: string; to: string };
  onRangeChange: (range: { from: string; to: string }) => void;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function shiftRange(range: { from: string; to: string }, deltaMs: number): { from: string; to: string } {
  return {
    from: new Date(new Date(range.from).getTime() + deltaMs).toISOString(),
    to: new Date(new Date(range.to).getTime() + deltaMs).toISOString(),
  };
}

export function CalendarRangeControls({ range, onRangeChange }: CalendarRangeControlsProps) {
  const t = useTranslations('content');
  const fromLabel = range.from.slice(5, 10);
  const toLabel = range.to.slice(5, 10);

  return (
    <div className="flex items-center gap-2" data-testid="channel-post-calendar-range-controls">
      <Button
        variant="outline" size="sm"
        onClick={() => onRangeChange(shiftRange(range, -WEEK_MS))}
        data-testid="channel-post-calendar-range-prev"
        aria-label={t('channelPostsCalendarRangePrevWeek')}
      >
        {'<'}
      </Button>
      <span className="text-sm text-foreground" data-testid="channel-post-calendar-range-label">
        {fromLabel} ~ {toLabel}
      </span>
      <Button
        variant="outline" size="sm"
        onClick={() => onRangeChange(shiftRange(range, WEEK_MS))}
        data-testid="channel-post-calendar-range-next"
        aria-label={t('channelPostsCalendarRangeNextWeek')}
      >
        {'>'}
      </Button>
    </div>
  );
}
