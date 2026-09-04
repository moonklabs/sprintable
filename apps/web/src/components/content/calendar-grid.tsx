import { toDateKey } from '@/components/content/schedule-format';
import { ChannelPostCard } from '@/components/content/channel-post-card';
import type { ChannelPostCalendarItem } from '@/components/content/use-channel-post-calendar-data';

// story #3422(doc §11 T8) — 채널(행) × 날짜(열) 격자. ②-b 3/N-a는 골격만(날짜 열 계산·
// 채널 행 나열) — 셀에 ChannelPostCard를 배치하는 건 3/N-b.
export interface CalendarChannel {
  connectionId: string;
  label: string;
}

export interface CalendarGridProps {
  scheduled: Map<string, ChannelPostCalendarItem[]>;
  channels: CalendarChannel[];
  range: { from: string; to: string };
  displayTimezone: string;
}

/** range.from~range.to 사이의 날짜 키(YYYY-MM-DD, displayTimezone 기준)를 하루 단위로
 * 전부 낸다 — scheduled Map에 값이 없는 날짜(빈 칸)도 열로 서야 격자가 안 끊긴다. */
function enumerateDateKeys(from: string, to: string, tz: string): string[] {
  const keys: string[] = [];
  const start = new Date(toDateKey(from, tz) + 'T00:00:00Z');
  const end = new Date(toDateKey(to, tz) + 'T00:00:00Z');
  for (let d = start; d.getTime() <= end.getTime(); d = new Date(d.getTime() + 86400000)) {
    keys.push(d.toISOString().slice(0, 10));
  }
  return keys;
}

export function CalendarGrid({ scheduled, channels, range, displayTimezone }: CalendarGridProps) {
  const dateKeys = enumerateDateKeys(range.from, range.to, displayTimezone);

  return (
    <div className="overflow-x-auto" data-testid="channel-post-calendar-grid">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr>
            <th className="w-32 border-b border-border p-2 text-left text-muted-foreground">
              {/* 채널 열 머리 — 라벨 없음(첫 칸은 채널 이름이 서는 자리표시). */}
            </th>
            {dateKeys.map((key) => (
              <th key={key} className="border-b border-border p-2 text-left text-muted-foreground" data-testid="channel-post-calendar-date-header">
                {key.slice(5)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {channels.map((channel) => (
            <tr key={channel.connectionId} data-testid="channel-post-calendar-channel-row">
              <td className="border-b border-border p-2 font-medium text-foreground">{channel.label}</td>
              {dateKeys.map((key) => {
                // 3/N-b — 그 날짜의 전체 항목 중 이 채널(연결) 것만 이 셀에 놓는다. 같은
                // (채널, 날짜)에 여러 초안이 있을 수 있다(doc 설계 "보통 0~1, 드물게 여러
                // 개") — 전부 쌓아 보인다(하나로 뭉개지 않는다).
                const dayItems = (scheduled.get(key) ?? []).filter((item) => item.connection_id === channel.connectionId);
                return (
                  <td key={key} className="border-b border-border p-2 align-top" data-testid="channel-post-calendar-cell">
                    <div className="space-y-1">
                      {dayItems.map((item) => (
                        <ChannelPostCard key={item.draft_id} item={item} displayTimezone={displayTimezone} />
                      ))}
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
