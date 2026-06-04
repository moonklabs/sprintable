'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { buttonVariants } from '@/components/ui/button';

// E-SETTINGS S5: authenticated 레이아웃 내 404 (사이드바/네비 유지, 콘텐츠 영역만).
// RouteErrorState 토큰 재사용(중앙 카드·muted 텍스트), 신규 디자인 토큰 0. S3 죽은 route도 재사용.
export default function NotFound() {
  const t = useTranslations('notFound');
  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-4 rounded-2xl border bg-card p-8 text-center shadow-lg">
        <p className="text-4xl font-bold text-muted-foreground">404</p>
        <div className="space-y-2">
          <p className="text-lg font-semibold text-foreground">{t('title')}</p>
          <p className="text-sm text-muted-foreground">{t('description')}</p>
        </div>
        <div className="flex justify-center">
          <Link href="/dashboard" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            {t('cta')}
          </Link>
        </div>
      </div>
    </div>
  );
}
