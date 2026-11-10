'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useDashboardContext } from '../../dashboard/dashboard-shell';
import { ActivityLogView } from '@/components/activity/activity-log-view';
import { TeamActivityView } from '@/components/activity/team-activity-view';
import { Button } from '@/components/ds/button';

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
      {/* story 4892 (UI-9 활동) — the two views (감사 로그 | 팀 활동) are one ds switch in the page header (was two underline tabs): a named group of two ds buttons,
          the open one `aria-current`. Each view keeps its own data / API. */}
      <div className="flex shrink-0 items-center border-b border-ds-line px-6 py-2">
        <div role="group" aria-label={t('tabsLabel')} className="inline-flex gap-0.5 rounded-ds-control border border-ds-line bg-ds-surface-sunk p-0.5">
          {TABS.map(({ value, labelKey }) => (
            <Button
              key={value}
              type="button"
              variant={tab === value ? 'secondary' : 'quiet'}
              onClick={() => setTab(value)}
              aria-current={tab === value ? 'page' : undefined}
              className="h-6 px-3"
            >
              {t(labelKey)}
            </Button>
          ))}
        </div>
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
