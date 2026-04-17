'use client';

import { useTranslations } from 'next-intl';
import { KanbanBoard } from '@/components/kanban/kanban-board';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard, SectionCardBody } from '@/components/ui/section-card';
import { useDashboardContext } from '../../dashboard/dashboard-shell';

export default function BoardPage() {
  const { projectId } = useDashboardContext();
  const t = useTranslations('board');
  const tc = useTranslations('common');

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow={tc('operatorSurface')}
        title={t('title')}
        description={t('subtitle')}
      />
      <SectionCard>
        <SectionCardBody>
          <KanbanBoard projectId={projectId} />
        </SectionCardBody>
      </SectionCard>
    </div>
  );
}
