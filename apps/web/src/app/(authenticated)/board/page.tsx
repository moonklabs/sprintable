'use client';

import { useTranslations } from 'next-intl';
import { KanbanBoard } from '@/components/kanban/kanban-board';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { useDashboardContext } from '../../dashboard/dashboard-shell';

export default function BoardPage() {
  const { projectId } = useDashboardContext();
  const t = useTranslations('board');

  return (
    <>
      <TopBarSlot title={<h1 className="text-sm font-medium">{t('title')}</h1>} />
      <KanbanBoard projectId={projectId} />
    </>
  );
}
