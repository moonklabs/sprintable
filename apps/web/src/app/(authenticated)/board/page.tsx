'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { KanbanBoard } from '@/components/kanban/kanban-board';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { useDashboardContext } from '../../dashboard/dashboard-shell';
import { OssWebhookBanner } from '@/components/oss/oss-webhook-banner';

const isOssMode = process.env['NEXT_PUBLIC_OSS_MODE'] === 'true';

export default function BoardPage() {
  const { projectId } = useDashboardContext();
  const t = useTranslations('board');

  useEffect(() => {
    if (!isOssMode) return;
    fetch('/api/oss/seed', { method: 'POST' }).catch(() => {});
  }, []);

  return (
    <>
      <TopBarSlot title={<h1 className="text-sm font-medium">{t('title')}</h1>} />
      {isOssMode ? <OssWebhookBanner /> : null}
      <KanbanBoard projectId={projectId} />
    </>
  );
}
