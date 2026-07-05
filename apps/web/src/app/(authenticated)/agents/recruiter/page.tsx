'use client';

import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { RecruiterClient } from './recruiter-client';
import { useTranslations } from 'next-intl';

export default function RecruiterPage() {
  const { projectId, orgId } = useDashboardContext();
  const t = useTranslations('recruiter');

  if (!projectId) {
    return (
      <div className="flex h-64 items-center justify-center">
        <p className="text-sm text-muted-foreground">{t('noProject')}</p>
      </div>
    );
  }

  return <RecruiterClient projectId={projectId} orgId={orgId} />;
}
