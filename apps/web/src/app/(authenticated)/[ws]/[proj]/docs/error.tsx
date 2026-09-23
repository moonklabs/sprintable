'use client';

import { useTranslations } from 'next-intl';
import { RouteErrorState } from '@/components/ui/route-error-state';

export default function DocsError({ error, reset }: { error: Error; reset: () => void }) {
  const tCommon = useTranslations('common');
  // story #4221 — 보조 버튼 라벨 = 실제 목적지(예전 기본값 «로그인으로 이동»은 거짓 표시).
  return <RouteErrorState error={error} reset={reset} compact secondaryHref="/docs" secondaryLabel={tCommon('backToDocs')} />;
}
