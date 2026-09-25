'use client';

import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * story #4274 → #4291 — 일감 프레임 여섯 경로(목록 · 보드 · 스프린트 · 에픽 · 회고 · 가설)의 loading 몸 스켈레톤.
 * 탭 줄은 `[ws]/[proj]` 레이아웃(WorkTabsFrame)의 sticky 띠에 살아 로딩 경계가 떠도 제자리에 남는다 — 여기는 그 아래 몸만 그린다.
 * 부모 `[ws]/[proj]/loading.tsx`도 도착이 이 여섯이면 같은 몸을 그려(동적 layout을 가진 회고) 스켈레톤이 두 번 바뀌지 않는다(parity 테스트).
 */
export function WorkspaceFrameLoading() {
  const t = useTranslations('common');
  // story #4291 — 탭 줄은 `[ws]/[proj]` 레이아웃의 sticky 띠(WorkTabsFrame)가 쥔다 — 로딩 경계는 그 아래 몸 스켈레톤만(겹치면 탭 줄 두 줄).
  // 예전 layout 갈래(inset · sticky)는 탭 줄 자리가 화면마다 둘이던 시절의 것이라 걷었다(유나 판정 · 한 자리 16px).
  return (
    <div className="space-y-3 p-4" role="status" aria-busy="true">
      <span className="sr-only">{t('loading')}</span>
      {Array.from({ length: 5 }).map((_, i) => (
        <Skeleton key={i} className="h-12 rounded-lg" />
      ))}
    </div>
  );
}
