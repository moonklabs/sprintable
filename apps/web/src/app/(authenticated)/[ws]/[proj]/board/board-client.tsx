'use client';

import { useTranslations } from 'next-intl';
import { KanbanBoard } from '@/components/kanban/kanban-board';
import { TopBarSlot } from '@/components/nav/top-bar-slot';

interface BoardPageClientProps {
  projectId: string;
  wsSlug: string;
  projSlug: string;
}

// story a539c649 S3d: projectId 는 이제 page.tsx(headers() 경유 resolve 결과)가 prop 으로
// 내려준다 — useDashboardContext()(전역 "현재 프로젝트")가 아니라 URL 이 가리키는 project.
// wsSlug/projSlug는 KanbanBoard 내부 자기참조+이미 이관된 sprints/epics로의 크로스링크에 필요.
export default function BoardPageClient({ projectId, wsSlug, projSlug }: BoardPageClientProps) {
  const t = useTranslations('board');

  return (
    <>
      <TopBarSlot title={<h1 className="text-sm font-medium">{t('title')}</h1>} />
      <KanbanBoard projectId={projectId} wsSlug={wsSlug} projSlug={projSlug} />
    </>
  );
}
