'use client';

import { useDashboardContext } from '../../dashboard/dashboard-shell';
import { DocsShellClient } from './docs-shell-client';
import { useTranslations } from 'next-intl';

export default function DocsPage() {
  const { projectId } = useDashboardContext();
  const t = useTranslations('docs');

  if (!projectId) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-gray-400">{t('noProject')}</p>
      </div>
    );
  }

  return <DocsShellClient projectId={projectId} />;
}
