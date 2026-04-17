'use client';

import { useTranslations } from 'next-intl';
import { RouteErrorState } from '@/components/ui/route-error-state';

export default function AuthenticatedError({ error, reset }: { error: Error; reset: () => void }) {
  const t = useTranslations('common');

  return (
    <RouteErrorState
      error={error}
      reset={reset}
      secondaryHref="/login"
      secondaryLabel={t('login')}
    />
  );
}
