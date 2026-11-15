import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type PageHeadProps = Omit<ComponentProps<'div'>, 'className' | 'title' | 'children'> & {
  /** 한 줄 설명 — 이 화면이 무엇을 하는지. */
  description?: ReactNode;
  /** 설명 아래 보조 글(예: 마지막으로 고친 사람 · 날짜) — 작은 글씨. */
  meta?: ReactNode;
  /** 오른쪽 한 곳 — 주 행동 하나 + 메뉴. 폰에서는 설명 아래로 내려온다. */
  actions?: ReactNode;
  className?: string;
};

/**
 * 4913(UI-R5) PageHead — 조직 구역 «쪽 머리». **제목이 없다**: 화면 제목은 앱 틀 위 막대(`TopBarSlot`)가 가져간다(보드 · 목표 · 문서 · 실행 등 다시 지은 화면과 같게 — PO 11-12).
 * 같은 이름이 두 자리에 나오지 않도록 이 부품은 제목 자리를 아예 갖지 않는다. 설명 · 보조 글 · 행동이 다 없으면 아무것도 그리지 않는다(빈 줄을 남기지 않는다).
 */
export function PageHead({ description, meta, actions, className, ...props }: PageHeadProps) {
  if (!description && !meta && !actions) return null;
  return (
    <div
      data-slot="ds-page-head"
      className={cn('flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between', className)}
      {...props}
    >
      <div className="min-w-0 space-y-1">
        {description ? <p className="m-0 max-w-prose text-ds-body text-ds-ink-2">{description}</p> : null}
        {meta ? <p className="m-0 text-ds-small text-ds-ink-3">{meta}</p> : null}
      </div>
      {actions ? <div data-slot="ds-page-head-actions" className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
