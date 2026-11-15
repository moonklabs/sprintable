import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type PageSplitProps = Omit<HTMLAttributes<HTMLDivElement>, 'children'> & {
  /** 본문 칸(왼쪽). */
  children: ReactNode;
  /** 옆 칸(오른쪽 16rem) 내용 — 보통 `SummaryCard`. 읽기만 하는 맥락 칸이다(눌리는 것은 본문에). */
  aside: ReactNode;
  /** 옆 칸 이름 — 필수(`aside`는 «보조 영역» 랜드마크라, 이름이 없으면 스크린리더가 «보조 영역» 여럿을 구별 못 한다). */
  asideLabel: string;
  /** 좁은 화면(lg 아래)에서 옆 칸의 자리: `above` = 본문 위(기본 — 지금까지 고른 것이 먼저 보인다) · `below` = 본문 아래. 읽기 순서는 늘 «본문 → 옆 칸»이다. */
  narrow?: 'above' | 'below';
};

/**
 * UI-3(a9d56577) PageSplit — 화면 틀: 본문 + 옆 칸(오른쪽 16rem). `lg` 이상은 두 칸, 그 아래는 한 칸(옆 칸이 본문 위 또는 아래).
 * 간격 16 · 본문 칸은 `min-w-0`(긴 글이 칸을 밀지 않는다). 옆 칸은 읽기 전용 맥락이라 좁은 화면에서 눈에 보이는 순서만 바꾸고 DOM 순서(= 읽기 · 초점 순서)는 «본문 → 옆 칸»을 지킨다.
 */
export function PageSplit({ children, aside, asideLabel, narrow = 'above', className, ...props }: PageSplitProps) {
  return (
    <div {...props} data-slot="ds-page-split" data-narrow={narrow} className={cn('grid gap-4 lg:grid-cols-[minmax(0,1fr)_16rem] lg:items-start', className)}>
      <div data-slot="ds-page-split-main" className="min-w-0">{children}</div>
      <aside data-slot="ds-page-split-aside" aria-label={asideLabel} className={cn('min-w-0', narrow === 'above' && 'max-lg:order-first')}>{aside}</aside>
    </div>
  );
}
