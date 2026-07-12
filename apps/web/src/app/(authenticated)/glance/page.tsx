'use client';

import { useTranslations } from 'next-intl';
import { useDashboardContext } from '../../dashboard/dashboard-shell';
import { GlanceBoard } from '@/components/glance/glance-board';

export default function GlancePage() {
  const { projectId } = useDashboardContext();
  const t = useTranslations('glance');

  if (!projectId) {
    return (
      <div className="flex h-64 items-center justify-center">
        <p className="text-sm text-muted-foreground">{t('noProject')}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
      <div>
        <h1 className="text-lg font-semibold text-foreground">{t('pageTitle')}</h1>
        <p className="mt-0.5 text-xs text-muted-foreground">{t('pageDescription')}</p>
      </div>
      <GlanceBoard projectId={projectId} />
    </div>
  );
}
