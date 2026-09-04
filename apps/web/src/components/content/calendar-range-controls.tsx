import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { shiftCalendarRange, toDateKey } from '@/components/content/schedule-format';

// story #3422(doc §11 T8) — 주 단위 이동(월 단위는 후속, 화면 자체는 range를 그대로
// 받아 그리므로 이 컴포넌트가 range 계산 방식을 늘려도 CalendarGrid는 안 바뀐다).
// 범위 계산은 순수 함수로 분리해 이 컴포넌트가 상태를 갖지 않는다(부모가 range를
// 소유 — useChannelPostCalendarData가 바로 그 range를 받는 훅이라 여기서 관리하면
// 두 곳이 상태를 나눠 갖게 된다).
//
// story #3422 B1(페드루 PO 재판정, 2026-09-04) — 이동·라벨 둘 다 tz 인자를 받는다.
// ①이동은 ms 산술(WEEK_MS) 대신 shiftCalendarRange(날짜 키 ±7일)로 — DST 전환 tz에서
// ms 산술은 한 시간이 밀려 열이 어긋난다(schedule-format.ts 상단 주석 참고). ②라벨은
// range.from/to의 ISO 문자열을 그대로 slice하지 않는다(UTC 기준이라 tz에 따라 그리드가
// 실제로 보여주는 첫/끝 열과 다른 날짜를 보일 수 있다) — CalendarGrid와 같은 toDateKey
// 함수로 «열 키»를 직접 뽑아 그 값을 라벨로 쓴다(단일 소스, 두 갈래 계산 금지).
export interface CalendarRangeControlsProps {
  range: { from: string; to: string };
  onRangeChange: (range: { from: string; to: string }) => void;
  displayTimezone: string;
}

export function CalendarRangeControls({ range, onRangeChange, displayTimezone }: CalendarRangeControlsProps) {
  const t = useTranslations('content');
  const fromLabel = toDateKey(range.from, displayTimezone).slice(5);
  const toLabel = toDateKey(range.to, displayTimezone).slice(5);

  return (
    <div className="flex items-center gap-2" data-testid="channel-post-calendar-range-controls">
      <Button
        variant="outline" size="sm"
        onClick={() => onRangeChange(shiftCalendarRange(range, displayTimezone, -7))}
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
        onClick={() => onRangeChange(shiftCalendarRange(range, displayTimezone, 7))}
        data-testid="channel-post-calendar-range-next"
        aria-label={t('channelPostsCalendarRangeNextWeek')}
      >
        {'>'}
      </Button>
    </div>
  );
}
