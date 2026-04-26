'use client';

import { useDashboardContext } from '../../dashboard/dashboard-shell';
import { SprintsClient } from './sprints-client';
import { useTranslations } from 'next-intl';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { EmptyState } from '@/components/ui/empty-state';

export default function SprintsPage() {
  const { projectId, orgId } = useDashboardContext();
  const t = useTranslations('sprints');
  const shellT = useTranslations('shell');

  if (!projectId) {
    return (
      <>
        <TopBarSlot title={<h1 className="text-sm font-medium">{t('title')}</h1>} />
        <div className="flex h-64 items-center justify-center p-6">
          <EmptyState title={shellT('projectSelectPrompt')} description={shellT('projectSelectDescription')} />
        </div>
      </>
    );
  }

  return <SprintsClient projectId={projectId} orgId={orgId ?? ''} />;
}
