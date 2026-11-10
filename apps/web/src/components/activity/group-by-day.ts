import { addCalendarDays, todayDateKey, toDateKey } from '@/lib/schedule-format';

/**
 * story 4892 (UI-9 활동) — the audit log was one long unbroken list. It is now grouped by DAY in the viewer's time zone: «오늘» · «어제» · then the date.
 * Order is kept (the server already sorts newest first); a day with no row has no header; the same day never appears twice in a row-ordered list.
 */
export interface DayGroup<T> {
  /** YYYY-MM-DD in the zone. */
  key: string;
  kind: 'today' | 'yesterday' | 'date';
  items: T[];
}

export function groupByDay<T extends { created_at: string }>(items: readonly T[], tz: string, now: Date = new Date()): DayGroup<T>[] {
  const today = todayDateKey(tz, now);
  const yesterday = addCalendarDays(today, -1);   // calendar arithmetic on the date key — a zone whose clock changes at midnight (DST) cannot skip or repeat a day
  const groups: DayGroup<T>[] = [];
  const index = new Map<string, DayGroup<T>>();
  for (const item of items) {
    const key = toDateKey(item.created_at, tz);
    let group = index.get(key);
    if (!group) {
      group = { key, kind: key === today ? 'today' : key === yesterday ? 'yesterday' : 'date', items: [] };
      index.set(key, group);
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}

/** the date header text for a `date` group (the zone's calendar day, written in the viewer's locale). */
export function formatDayHeader(key: string, locale: string): string {
  const noon = new Date(`${key}T12:00:00Z`);
  return new Intl.DateTimeFormat(locale, { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' }).format(noon);
}
