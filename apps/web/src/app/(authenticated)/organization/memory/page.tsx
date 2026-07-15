'use client';

import { useTranslations } from 'next-intl';
import { Brain } from 'lucide-react';
import { EmptyState } from '@/components/ui/empty-state';

export default function OrganizationMemoryPage() {
  const t = useTranslations('organization');
  return (
    <div className="mx-auto w-full max-w-3xl p-6">
      <EmptyState
        icon={<Brain className="size-8" />}
        title={t('memorySlotTitle')}
        description={t('memorySlotBody')}
      />
    </div>
  );
}
