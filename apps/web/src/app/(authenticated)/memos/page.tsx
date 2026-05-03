'use client';

import { Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { useDashboardContext } from '../../dashboard/dashboard-shell';

export default function MemosPage() {
  const t = useTranslations('memos');
  const router = useRouter();
  const { currentTeamMemberId } = useDashboardContext();

  if (!currentTeamMemberId) {
    return (
      <div className="flex h-64 items-center justify-center">
        <p className="text-sm text-muted-foreground">{t('noTeamMember')}</p>
      </div>
    );
  }

  return (
    <>
      <TopBarSlot
        title={<h1 className="text-sm font-medium">{t('title')}</h1>}
        actions={
          <Button size="sm" variant="outline" onClick={() => router.push('/memos/new')}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            {t('newMemo')}
          </Button>
        }
      />
      <div className="flex flex-1 items-center justify-center p-4">
        <EmptyState
          title={t('title')}
          description={t('selectMemo')}
          className="w-full max-w-lg bg-background/70"
        />
      </div>
    </>
  );
}
