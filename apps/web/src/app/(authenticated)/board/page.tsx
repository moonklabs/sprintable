'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { KanbanBoard } from '@/components/kanban/kanban-board';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard, SectionCardBody } from '@/components/ui/section-card';
import { useDashboardContext } from '../../dashboard/dashboard-shell';
import { OssWebhookBanner } from '@/components/oss/oss-webhook-banner';

const isOssMode = process.env['NEXT_PUBLIC_OSS_MODE'] === 'true';

export default function BoardPage() {
  const { projectId } = useDashboardContext();
  const t = useTranslations('board');
  const tc = useTranslations('common');

  useEffect(() => {
    if (!isOssMode) return;
    fetch('/api/oss/seed', { method: 'POST' }).catch(() => {});
  }, []);

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow={tc('operatorSurface')}
        title={t('title')}
        description={t('subtitle')}
        actions={isOssMode ? <OssWebhookBanner /> : undefined}
      />
      <SectionCard>
        <SectionCardBody>
          <KanbanBoard projectId={projectId} />
        </SectionCardBody>
      </SectionCard>
    </div>
  );
}
