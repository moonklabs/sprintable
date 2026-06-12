'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useDashboardContext } from '../../dashboard/dashboard-shell';
import { ActivityLogView } from '@/components/activity/activity-log-view';
import { TeamActivityView } from '@/components/activity/team-activity-view';
import { cn } from '@/lib/utils';

type ActivityTab = 'audit' | 'team';

const TABS: { value: ActivityTab; labelKey: 'tabAudit' | 'tabTeamActivity' }[] = [
  { value: 'audit', labelKey: 'tabAudit' },
  { value: 'team', labelKey: 'tabTeamActivity' },
];

export default function ActivityPage() {
  const { projectId } = useDashboardContext();
  const t = useTranslations('teamActivity');
  const [tab, setTab] = useState<ActivityTab>('audit');

  if (!projectId) {
    return (
      <div className="flex h-64 items-center justify-center">
        <p className="text-sm text-muted-foreground">{t('noProject')}</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 하위 2탭 — 감사 로그(기존 그대로·무변경·AC①) | 팀 활동(신규). 시각 형식 대비:
          audit=테이블 / 팀활동=피드형 리스트. */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border/80 px-6 pt-2">
        {TABS.map(({ value, labelKey }) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={cn(
              'relative px-3 py-2 text-sm font-medium transition',
              tab === value ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
            aria-current={tab === value ? 'page' : undefined}
          >
            {t(labelKey)}
            {tab === value ? (
              <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-primary" />
            ) : null}
          </button>
        ))}
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {tab === 'audit' ? (
          <ActivityLogView projectId={projectId} />
        ) : (
          <TeamActivityView projectId={projectId} />
        )}
      </div>
    </div>
  );
}
