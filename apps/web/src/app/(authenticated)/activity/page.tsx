'use client';

import { useDashboardContext } from '../../dashboard/dashboard-shell';
import { ActivityLogView } from '@/components/activity/activity-log-view';
import { useTranslations } from 'next-intl';

export default function ActivityPage() {
  const { projectId } = useDashboardContext();
  const t = useTranslations('activityLog');

  if (!projectId) {
    return (
      <div className="flex h-64 items-center justify-center">
        <p className="text-sm text-muted-foreground">{t('noProject')}</p>
      </div>
    );
  }

  return <ActivityLogView projectId={projectId} />;
}
