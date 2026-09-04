'use client';

import { useEffect, useState } from 'react';
import { fetchWithAuth } from '@/lib/db/client';
import { resolveDisplayTimezone, toDateKey } from './schedule-format';

// story #3422(Phase1·마케팅운영, doc §11 T8) — 캘린더가 필요로 하는 두 축(그리드용 기간
// 조회·「날짜 미정」 레인용 미예약 조회)은 서로 배타적 필터라(BE #3423/PR#3775 —
// scheduled_from/scheduled_to는 unscheduled와 함께 못 준다) 한 번에 못 받는다 — 두 번
// 왕복한다(§11-5 "행마다 부르면 N번 왕복"은 피하되, 축 자체가 다른 둘은 합칠 필요 없다는
// 것이 그 문장의 뜻이다 — «행마다»가 아니라 «두 축 조회 한 번씩»이면 된다).
export interface ChannelPostCalendarItem {
  draft_id: string;
  connection_id: string;
  channel: string;
  gate_status?: string | null;
  reapproval_required?: boolean | null;
  sealed_content_sha256?: string | null;
  body_sha256: string;
  published_at?: string | null;
  published_body_sha256?: string | null;
  publication_status?: string | null;
  error_code?: string | null;
  scheduled_at?: string | null;
  command_status?: string | null;
  command_reason_code?: string | null;
  text_preview?: string;
}

export interface ChannelPostCalendarData {
  /** key = scheduled_at의 날짜(YYYY-MM-DD), displayTimezone 기준 — 표기(formatScheduledAt)
   * 와 같은 tz를 써야 21:30 KST 예약이 UTC 격자의 전날 칸에 서는 어긋남이 안 난다(페드루
   * PO 지적 2026-09-04 08:57Z). */
  scheduled: Map<string, ChannelPostCalendarItem[]>;
  unscheduled: ChannelPostCalendarItem[];
  loading: boolean;
  error: boolean;
  /** 그룹핑·표기에 실제로 쓴 tz — 조직 타임존 필드가 없어(그라운딩 확認) 브라우저 폴백이다.
   * isOrgTimezone=false면 소비부가 "브라우저 시간대" 안내를 붙인다. */
  displayTimezone: { tz: string; isOrgTimezone: boolean };
}

export function useChannelPostCalendarData(
  orgId: string | undefined,
  range: { from: string; to: string },
  connectionId?: string,
): ChannelPostCalendarData {
  const [scheduled, setScheduled] = useState<Map<string, ChannelPostCalendarItem[]>>(new Map());
  const [unscheduled, setUnscheduled] = useState<ChannelPostCalendarItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  // 렌더마다 새 객체를 안 만든다 — effect의 의존 배열에 걸리면 매 렌더 재조회가 된다.
  const [displayTimezone] = useState(resolveDisplayTimezone);

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(false);
      try {
        const scheduledParams = new URLSearchParams({ scheduled_from: range.from, scheduled_to: range.to, limit: '200' });
        const unscheduledParams = new URLSearchParams({ unscheduled: 'true', limit: '200' });
        if (connectionId) {
          scheduledParams.set('connection_id', connectionId);
          unscheduledParams.set('connection_id', connectionId);
        }
        const [scheduledRes, unscheduledRes] = await Promise.all([
          fetchWithAuth(`/api/organizations/${orgId}/channel-posts/drafts?${scheduledParams}`),
          fetchWithAuth(`/api/organizations/${orgId}/channel-posts/drafts?${unscheduledParams}`),
        ]);
        if (cancelled) return;
        if (!scheduledRes.ok || !unscheduledRes.ok) {
          setError(true);
          return;
        }
        const scheduledJson = (await scheduledRes.json().catch(() => null)) as { data?: ChannelPostCalendarItem[] } | null;
        const unscheduledJson = (await unscheduledRes.json().catch(() => null)) as { data?: ChannelPostCalendarItem[] } | null;
        const grouped = new Map<string, ChannelPostCalendarItem[]>();
        for (const item of scheduledJson?.data ?? []) {
          // scheduled_at 자체가 없는 항목은 그리드에 놓을 날짜가 없다 — 조용히 건너뛴다
          // (필터가 정확했다면 안 와야 하지만, 계약이 흔들려도 화면이 죽지 않게 방어).
          if (!item.scheduled_at) continue;
          const key = toDateKey(item.scheduled_at, displayTimezone.tz);
          const bucket = grouped.get(key) ?? [];
          bucket.push(item);
          grouped.set(key, bucket);
        }
        setScheduled(grouped);
        setUnscheduled(unscheduledJson?.data ?? []);
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [orgId, range.from, range.to, connectionId]);

  return { scheduled, unscheduled, loading, error, displayTimezone };
}
