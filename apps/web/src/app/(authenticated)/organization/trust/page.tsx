'use client';

import { useTranslations } from 'next-intl';
import { Award } from 'lucide-react';
import { EmptyState } from '@/components/ui/empty-state';

export default function OrganizationTrustPage() {
  const t = useTranslations('organization');
  return (
    <div className="mx-auto w-full max-w-3xl p-6">
      <EmptyState
        icon={<Award className="size-8" />}
        title={t('trustSlotTitle')}
        description={t('trustSlotBody')}
      />
    </div>
  );
}
