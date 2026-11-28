'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ds/button';
import { EmptyState } from '@/components/ds/empty-state';

// story 5048 ⑤ — 루트의 «없는 길»(맨 위 URL이 아무 화면에도 안 맞을 때). 이 파일이 없으면 Next 기본 «404 | This page could not be found.»(영어 · 돌아갈 길 없음)가 뜬다 —
// 맨 위 없는 길은 `(authenticated)/not-found.tsx`가 아니라 여기로 온다(그쪽은 그 무리 안에서 notFound()를 부를 때만).
// 「없음」은 「에러」가 아니다: ds EmptyState(알림 역할 없음) + 다음 행동 하나(홈으로). 루트 레이아웃이 i18n · 테마를 이미 감싸고 있어 같은 글(`notFound.*` · ko/en)을 쓴다.
// 홈 = `/` — 로그인했으면 오늘 화면으로, 아니면 로그인으로 가는 루트 페이지(`app/page.tsx`)가 정한다.
export default function RootNotFound() {
  const t = useTranslations('notFound');
  return (
    <main className="flex min-h-[60vh] items-center justify-center bg-ds-background p-6">
      <EmptyState
        icon="search"
        title={t('title')}
        description={t('description')}
        action={(
          <Button asChild variant="secondary">
            <Link href="/">{t('cta')}</Link>
          </Button>
        )}
      />
    </main>
  );
}
