'use client';

import { useTranslations } from 'next-intl';
import { RouteErrorState } from '@/components/ui/route-error-state';
import { useFlatHref } from '@/hooks/use-flat-href';

export default function StorageError({ error, reset }: { error: Error; reset: () => void }) {
  const flatHref = useFlatHref(); // story #4231 4차 B — 옛 자원 경로(flat 목적지)에 프로젝트
  const t = useTranslations('storage');
  const tCommon = useTranslations('common');
  return (
    <RouteErrorState
      error={error}
      reset={reset}
      title={t('errorTitle')}
      description={t('errorDesc')}
      compact
      secondaryHref={flatHref('/storage')}
      // story #4221 — 보조 버튼 라벨 = 실제 목적지(예전 기본값 «로그인으로 이동»은 거짓 표시).
      secondaryLabel={tCommon('backToStorage')}
    />
  );
}
