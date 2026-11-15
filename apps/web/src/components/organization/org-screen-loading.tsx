'use client';

import { useTranslations } from 'next-intl';
import { PageFrame, type PageFrameWidth } from '@/components/ds/page-frame';
import { Skeleton } from '@/components/ds/skeleton';

/**
 * 4913(UI-R5) 조직 구역 화면의 «불러오는 중» 본문 — 도착 화면과 **같은 틀**(PageFrame 폭 · 여백)에 설명 줄 하나 + 행 셋. 제목은 위 막대(화면의 OrgScreenTitle · 로딩의 RouteTopBarFallback)가 쥔다.
 * 화면 읽기 프로그램에 «불러오는 중»을 상태로 알린다(story #4274: role="status" · aria-busy · sr-only 라벨).
 */
export function OrgScreenLoading({ width = 'reading' }: { width?: PageFrameWidth }) {
  const t = useTranslations('common');
  return (
    <PageFrame width={width} role="status" aria-busy="true">
      <span className="sr-only">{t('loading')}</span>
      <Skeleton className="h-5 w-64 max-w-full" />
      {[1, 2, 3].map((i) => <Skeleton key={i} className="h-14 w-full" />)}
    </PageFrame>
  );
}
