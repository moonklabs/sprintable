'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations, useLocale } from 'next-intl';
import { Activity, ChevronRight } from 'lucide-react';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';

import { fetchWithAuth } from '@/lib/db/client';
import { formatRelativeTime } from '@/lib/storage/format';
import { resolveDisplayTimezone } from '@/components/content/schedule-format';

interface ActivityLogItem {
  id: string;
  actor_id: string | null;
  actor_name: string | null;
  actor_type: 'human' | 'agent' | null;
  action: string;
  entity_type: string | null;
  entity_title: string | null;
  context: Record<string, unknown> | null;
  created_at: string;
}

interface DashboardActivityTimelineProps {
  projectId: string;
}

const LIMIT = 10;
const POLL_INTERVAL = 60_000;

function getInitials(name: string | null): string {
  if (!name) return '?';
  return name
    .split(' ')
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
}

function avatarClass(type: 'human' | 'agent' | null): string {
  return type === 'agent'
    ? 'bg-primary/15 text-primary'
    : 'bg-muted text-muted-foreground';
}

function formatAction(action: string, entityType: string | null, entityTitle: string | null, t: ReturnType<typeof useTranslations<'activityTimeline'>>): string {
  const entity = entityTitle ? `"${entityTitle.slice(0, 30)}"` : entityType ?? '';
  switch (action) {
    case 'story.status_changed': return t('actionStoryStatus', { entity });
    case 'story.created': return t('actionStoryCreated', { entity });
    case 'agent_run.completed': return t('actionRunCompleted', { entity });
    case 'agent_run.failed': return t('actionRunFailed', { entity });
    case 'sprint.started': return t('actionSprintStarted', { entity });
    case 'sprint.closed': return t('actionSprintClosed', { entity });
    case 'doc.created': return t('actionDocCreated', { entity });
    default: {
      const label = action.replace(/[._]/g, ' ');
      return entity ? `${label} — ${entity}` : label;
    }
  }
}

// story #3493 — 손으로 짠 상대시각(하드코딩 영문 "s/m/h ago", locale 무시 버그
// 있었음)이 3436 묶음 8 정본(formatRelativeTime)과 별개로 존재하던 자리. 정본에
// 위임하되, 이 컴포넌트의 실제 값(1분 주기 재계산)은 그대로 유지 — formatRelativeTime
// 은 순수 함수라 "몇 분 전"이 시간이 지나며 자동으로 갱신되려면 호출부가 스스로
// 다시 불러야 한다(정본이 새로 제공하는 기능이 아니다, 새 포맷 함수 신설 금지 원칙과
// 무관 — 재호출 주기는 이 컴포넌트의 몫).
function RelativeTime({ iso, locale }: { iso: string; locale: string }) {
  const displayTimezone = resolveDisplayTimezone().tz;
  const [label, setLabel] = useState(() => formatRelativeTime(iso, locale, displayTimezone));
  useEffect(() => {
    function compute() {
      setLabel(formatRelativeTime(iso, locale, displayTimezone));
    }
    compute();
    const id = setInterval(compute, 60_000);
    return () => clearInterval(id);
  }, [iso, locale, displayTimezone]);
  return <span className="shrink-0 text-[11px] text-muted-foreground">{label}</span>;
}

export function DashboardActivityTimeline({ projectId }: DashboardActivityTimelineProps) {
  const t = useTranslations('activityTimeline');
  const locale = useLocale();
  const [items, setItems] = useState<ActivityLogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchItems = useCallback(async () => {
    if (!projectId) return;
    try {
      const res = await fetchWithAuth(`/api/activity-logs?project_id=${projectId}&limit=${LIMIT}`);
      if (!res.ok) return;
      const json = await res.json() as { data: { items: ActivityLogItem[] } | null };
      if (json.data?.items) setItems(json.data.items.slice(0, LIMIT));
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  // Initial load + polling
  useEffect(() => {
    void fetchItems();
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(fetchItems, POLL_INTERVAL);
    const handleVisibility = () => {
      if (document.hidden) {
        if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
      } else {
        void fetchItems();
        if (!intervalRef.current) intervalRef.current = setInterval(fetchItems, POLL_INTERVAL);
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [fetchItems]);

  return (
    <SectionCard className="xl:col-span-2">
      <SectionCardHeader>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Activity className="size-4 text-primary" />
            <div className="text-sm font-semibold text-foreground">{t('title')}</div>
          </div>
          <Link
            href="/activity"
            className="flex items-center gap-1 text-xs text-primary hover:underline"
          >
            {t('viewAll')}
            <ChevronRight className="size-3" />
          </Link>
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">{t('description')}</p>
      </SectionCardHeader>
      <SectionCardBody className="space-y-1">
        {loading ? (
          <div className="space-y-2 py-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-10 animate-pulse rounded-md bg-muted/50" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          items.map((item) => (
            <div
              key={item.id}
              className="flex items-center gap-3 rounded-md px-2 py-2 transition-colors hover:bg-muted/40"
            >
              <span
                className={`flex size-7 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${avatarClass(item.actor_type)}`}
                aria-hidden="true"
              >
                {getInitials(item.actor_name)}
              </span>
              <div className="min-w-0 flex-1">
                <span className="text-xs font-medium text-foreground">
                  {item.actor_name ?? t('unknownActor')}
                </span>
                <span className="text-xs text-muted-foreground">
                  {' — '}
                  {formatAction(item.action, item.entity_type, item.entity_title, t)}
                </span>
              </div>
              <RelativeTime iso={item.created_at} locale={locale} />
            </div>
          ))
        )}
      </SectionCardBody>
    </SectionCard>
  );
}
