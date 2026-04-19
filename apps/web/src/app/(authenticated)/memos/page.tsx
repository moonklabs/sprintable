'use client';

import { useDashboardContext } from '../../dashboard/dashboard-shell';
import { MemosFeedClient } from './memos-feed-client';
import { useTranslations } from 'next-intl';

export default function MemosPage() {
  const { currentTeamMemberId, projectId } = useDashboardContext();
  const t = useTranslations('memos');

  if (!currentTeamMemberId) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-[color:var(--operator-muted)]">{t('noTeamMember')}</p>
      </div>
    );
  }

  return <MemosFeedClient currentTeamMemberId={currentTeamMemberId} projectId={projectId} />;
}
