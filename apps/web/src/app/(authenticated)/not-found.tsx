'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { buttonVariants } from '@/components/ui/button';
import { useChatsHref } from '@/app/dashboard/dashboard-shell';

// E-SETTINGS S5: authenticated 레이아웃 내 404 (사이드바/네비 유지, 콘텐츠 영역만).
// RouteErrorState 토큰 재사용(중앙 카드·muted 텍스트), 신규 디자인 토큰 0. S3 죽은 route도 재사용.
export default function NotFound() {
  const t = useTranslations('notFound');
  // story #4017(PO 확定 2026-09-17) — (authenticated) 레이아웃의 DashboardShell 안이라
  // context로 플래그를 받는다('use client'라 process.env 직접 못 읽음).
  const chatsHref = useChatsHref();
  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-4 rounded-2xl border bg-card p-8 text-center shadow-lg">
        <p className="text-4xl font-bold text-muted-foreground">404</p>
        <div className="space-y-2">
          <p className="text-lg font-semibold text-foreground">{t('title')}</p>
          <p className="text-sm text-muted-foreground">{t('description')}</p>
        </div>
        <div className="flex justify-center">
          {/* story #3179(S3c) — /dashboard 폐합, 홈=chat 재조준. story #4017 — 목적지 모듈. */}
          <Link href={chatsHref} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            {t('cta')}
          </Link>
        </div>
      </div>
    </div>
  );
}
