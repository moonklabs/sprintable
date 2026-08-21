import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * story #2879(S1b) — PageHeader ↔ top-bar(+slot) 역할 정리(스펙 §2, doc
 * ui-overhaul-s1-primitives-spec 기준).
 *
 * - **top-bar**(`components/nav/top-bar.tsx` + `TopBarSlot`) = 글로벌 chrome 상단 —
 *   브레드크럼/현재 화면명·컨텍스트 칩(조직·프로젝트 전환)·전역 액션(알림·presence 등).
 *   `<1024`에서 특히 "지금 어디에 있는지"를 화면 제목보다 먼저 보여주는 상시 표면이다.
 * - **PageHeader**(이 파일) = 페이지 **본문** 최상단 제목 블록 — 그 화면의 콘텐츠 위계에서
 *   h1을 소유한다. eyebrow(여정/컨텍스트 라벨, 예: 소속 에픽·목표명 — Task→Trust 서사
 *   훅으로 활용 가능)+title+description+actions.
 *
 * **규칙(한 화면에 title을 그리는 표면은 하나만):** top-bar 슬롯의 `title`과 PageHeader의
 * `title`을 같은 화면에서 동시에 쓰지 않는다 — 어느 쪽이 title을 갖는지는 화면 타입으로 정한다.
 *   - **루트/목록형 화면**(보드·목표목록 등 컨텍스트를 "훑는" 화면): top-bar 슬롯이 title을
 *     가진다(현재 관례 — TopBarSlot 소비처 다수). PageHeader는 안 쓰거나 title 없이 actions만.
 *   - **콘텐츠 본문이 두꺼운 상세/도구 화면**(내부 대시보드·상세 패널 등 PageHeader 기존
 *     소비처 2곳): PageHeader가 title을 가진다 — 이런 화면은 보통 top-bar 슬롯을 title 없이
 *     쓰거나 아예 안 쓴다.
 * 새 화면을 만들 때 이 표를 참고해 딱 하나만 고른다(dual-header 방지).
 */
const pageHeaderVariants = cva('font-heading font-bold tracking-tight text-foreground', {
  variants: {
    size: {
      page: 'text-2xl md:text-3xl',
      section: 'text-xl',
      compact: 'text-lg',
    },
  },
  defaultVariants: { size: 'page' },
});

export interface PageHeaderProps extends VariantProps<typeof pageHeaderVariants> {
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}

export function PageHeader({ eyebrow, title, description, actions, className, size }: PageHeaderProps) {
  return (
    <section className={cn('flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between', className)}>
      <div className="space-y-1.5">
        {eyebrow ? <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">{eyebrow}</div> : null}
        <h1 className={cn(pageHeaderVariants({ size }))}>{title}</h1>
        {description ? <p className="max-w-2xl text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-3">{actions}</div> : null}
    </section>
  );
}
