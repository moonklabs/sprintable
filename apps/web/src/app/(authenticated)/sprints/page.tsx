'use client';

import { useDashboardContext } from '../../dashboard/dashboard-shell';
import { SprintsClient } from './sprints-client';
import { useTranslations } from 'next-intl';

export default function SprintsPage() {
  const { projectId, orgId } = useDashboardContext();
  const t = useTranslations('sprints');

  if (!projectId) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-[color:var(--operator-muted)]">{t('noProject')}</p>
      </div>
    );
  }

  return <SprintsClient projectId={projectId} orgId={orgId ?? ''} />;
}
