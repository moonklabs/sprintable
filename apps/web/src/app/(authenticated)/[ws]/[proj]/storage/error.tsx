'use client';

import { useTranslations } from 'next-intl';
import { RouteErrorState } from '@/components/ui/route-error-state';

export default function StorageError({ error, reset }: { error: Error; reset: () => void }) {
  const t = useTranslations('storage');
  return (
    <RouteErrorState
      error={error}
      reset={reset}
      title={t('errorTitle')}
      description={t('errorDesc')}
      compact
      secondaryHref="/storage"
    />
  );
}
