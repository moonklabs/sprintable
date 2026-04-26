'use client';

import { useDashboardContext } from '../../dashboard/dashboard-shell';
import { EpicsClient } from './epics-client';
import { useTranslations } from 'next-intl';

export default function EpicsPage() {
  const { projectId, orgId } = useDashboardContext();
  const t = useTranslations('epics');

  if (!projectId) {
    return (
      <div className="flex h-64 items-center justify-center">
        <p className="text-sm text-[color:var(--operator-muted)]">{t('noProject')}</p>
      </div>
    );
  }

  return <EpicsClient projectId={projectId} orgId={orgId} />;
}
