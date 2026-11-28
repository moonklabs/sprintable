'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ds/button';
import { EmptyState } from '@/components/ds/empty-state';
import { useChatsHref } from '@/app/dashboard/dashboard-shell';

// E-SETTINGS S5: authenticated 레이아웃 내 404 (사이드바/네비 유지, 콘텐츠 영역만).
// story 5048 ⑤-⑥ — «없음»은 «에러»가 아니다: ds EmptyState(알림 역할 없음 · assertive로 읽히지 않는다) + 다음 행동 하나(홈으로). 옛: 손으로 그린 테두리 카드 + 큰 «404» + 그림자.
export default function NotFound() {
  const t = useTranslations('notFound');
  // story #4017(PO 확定 2026-09-17) — (authenticated) 레이아웃의 DashboardShell 안이라
  // context로 플래그를 받는다('use client'라 process.env 직접 못 읽음).
  const chatsHref = useChatsHref();
  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <EmptyState
        icon="search"
        title={t('title')}
        description={t('description')}
        action={(
          // story #3179(S3c) — /dashboard 폐합, 홈=chat 재조준. story #4017 — 목적지 모듈.
          <Button asChild variant="secondary">
            <Link href={chatsHref}>{t('cta')}</Link>
          </Button>
        )}
      />
    </div>
  );
}
