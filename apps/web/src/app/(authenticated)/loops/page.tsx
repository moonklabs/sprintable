'use client';

import { useDashboardContext } from '../../dashboard/dashboard-shell';
import { LoopsClient } from './loops-client';
import { useTranslations } from 'next-intl';

export default function LoopsPage() {
  const { projectId } = useDashboardContext();
  const t = useTranslations('loops');

  if (!projectId) {
    return (
      <div className="flex h-64 items-center justify-center">
        <p className="text-sm text-muted-foreground">{t('noProject')}</p>
      </div>
    );
  }

  return <LoopsClient projectId={projectId} />;
}
