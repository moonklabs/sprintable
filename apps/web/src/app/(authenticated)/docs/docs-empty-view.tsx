'use client';

import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { useTranslations } from 'next-intl';
import { useDocsLayout } from './docs-context';

export function DocsEmptyView() {
  const t = useTranslations('docs');
  const { handleNewDoc } = useDocsLayout();

  return (
    <div className="flex h-full items-center justify-center p-4 lg:p-6">
      <EmptyState
        title={t('title')}
        description={t('selectDoc')}
        className="w-full max-w-lg bg-background/70"
        action={
          <Button size="sm" onClick={handleNewDoc}>
            <Plus className="mr-1 h-4 w-4" />
            {t('newDoc')}
          </Button>
        }
      />
    </div>
  );
}
