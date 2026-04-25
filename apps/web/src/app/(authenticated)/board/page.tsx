'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { KanbanBoard } from '@/components/kanban/kanban-board';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { SectionCard, SectionCardBody } from '@/components/ui/section-card';
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
    <div className="space-y-4">
      <TopBarSlot title={<h1 className="text-sm font-medium">{t('title')}</h1>} />
      {isOssMode ? <OssWebhookBanner /> : null}
      <SectionCard>
        <SectionCardBody>
          <KanbanBoard projectId={projectId} />
        </SectionCardBody>
      </SectionCard>
    </div>
  );
}
