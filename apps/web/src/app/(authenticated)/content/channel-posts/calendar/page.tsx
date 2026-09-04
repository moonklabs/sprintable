'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { EmptyState } from '@/components/ui/empty-state';
import { fetchWithAuth } from '@/lib/db/client';
import { useChannelPostCalendarData } from '@/components/content/use-channel-post-calendar-data';
import { CalendarGrid, type CalendarChannel } from '@/components/content/calendar-grid';
import { UnscheduledLane } from '@/components/content/unscheduled-lane';
import { CalendarRangeControls } from '@/components/content/calendar-range-controls';

/**
 * story #3422(Phase1·마케팅운영, doc §11 T8/T9) — 채널 포스트 캘린더. ③ 조립 조각 —
 * ②에서 만든 부품(useChannelPostCalendarData·CalendarGrid·UnscheduledLane·
 * CalendarRangeControls)을 한 라우트로 배선하기만 한다(새 로직을 여기서 만들지 않는다).
 *
 * 조직 timezone — story #46da6450(BE 착수, 2026-09-04) 착지 前이라 organizations
 * 응답에 그 필드가 없다. 페드루 PO 지시("optional chaining으로 null 취급") 그대로 —
 * 지금은 org 객체 자체가 없어 undefined를 그대로 넘긴다(useChannelPostCalendarData가
 * undefined를 브라우저 tz 폴백으로 처리, resolveDisplayTimezone 참고). BE 착지 뒤
 * 이 한 줄(orgTimezone 값의 출처)만 바꾸면 된다 — 그 외 배선은 이미 tz 인자 구조로
 * 흡수돼 있다.
 */
function defaultRange(): { from: string; to: string } {
  const now = new Date();
  const from = new Date(now); from.setUTCHours(0, 0, 0, 0);
  const to = new Date(from.getTime() + 6 * 86400000); to.setUTCHours(23, 59, 59, 999);
  return { from: from.toISOString(), to: to.toISOString() };
}

interface ChannelConnectionSummary {
  id: string;
  account_label: string | null;
  account_id: string;
}

export default function ChannelPostCalendarPage() {
  const { orgId } = useDashboardContext();
  const t = useTranslations('content');

  const [range, setRange] = useState(defaultRange);
  const [connections, setConnections] = useState<ChannelConnectionSummary[]>([]);
  const [connectionsError, setConnectionsError] = useState(false);
  const orgTimezone = undefined; // BE #46da6450 착지 前 — 위 docstring 참고.

  const data = useChannelPostCalendarData(orgId, range, undefined, orgTimezone);

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    async function load() {
      try {
        const res = await fetchWithAuth(`/api/organizations/${orgId}/channel-connections`);
        if (cancelled) return;
        if (res.ok) {
          const json = (await res.json().catch(() => null)) as { data?: ChannelConnectionSummary[] } | null;
          setConnections(json?.data ?? []);
        } else {
          setConnectionsError(true);
        }
      } catch {
        if (!cancelled) setConnectionsError(true);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [orgId]);

  const channels: CalendarChannel[] = useMemo(
    () => connections.map((c) => ({ connectionId: c.id, label: c.account_label ?? c.account_id })),
    [connections],
  );

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="font-heading text-lg font-medium text-foreground">{t('channelPostsCalendarPageTitle')}</h1>
        <CalendarRangeControls range={range} onRangeChange={setRange} />
      </div>

      {data.error || connectionsError ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{t('channelPostsCalendarLoadError')}</AlertDescription>
        </Alert>
      ) : data.loading ? (
        <p className="text-sm text-muted-foreground">{t('channelPostsCalendarLoading')}</p>
      ) : channels.length === 0 ? (
        <EmptyState title={t('channelPostsCalendarNoChannelsTitle')} description={t('channelPostsCalendarNoChannelsDescription')} />
      ) : (
        <>
          <UnscheduledLane items={data.unscheduled} displayTimezone={data.displayTimezone.tz} />
          <CalendarGrid scheduled={data.scheduled} channels={channels} range={range} displayTimezone={data.displayTimezone.tz} />
        </>
      )}
    </div>
  );
}
