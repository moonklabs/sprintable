'use client';

import { useId, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Button } from './button';

export interface FilterBarProps {
  /** 왼쪽 — 탭 · 칩. */
  leading?: ReactNode;
  /** 오른쪽 — 선택 · 검색 · 토글(예: «보관됨 보기»). */
  trailing?: ReactNode;
  /**
   * 폰(sm 미만)에서 한 단추로 접는다 — 단추 글은 `collapseLabel`, 적용 중인 거르기 수는 `activeCount`(0이면 안 붙인다).
   * 좁은 화면에서 거르기 줄이 첫 화면을 다 먹지 않게(성과 보드가 쓰던 «필터 펼치기»를 틀로 올린 것). 넓은 화면은 늘 펼쳐 있다.
   */
  collapseLabel?: string;
  activeCount?: number;
  /** 접근성 이름 — 거르기 줄이 어떤 목록을 거르는지. */
  'aria-label'?: string;
  className?: string;
}

/**
 * 4913(UI-R5) FilterBar — «거르기 줄» 한 가지 꼴. 탭 줄(`TabNav` — 다른 주소로 가는 길)과 섞지 않는다: 이 줄은 지금 화면 안 목록을 거른다.
 * 왼쪽 탭/칩 · 오른쪽 선택/토글, 줄바꿈 허용. `collapseLabel`을 주면 폰에서 접히는 단추가 앞에 선다.
 */
export function FilterBar({ leading, trailing, collapseLabel, activeCount = 0, className, ...rest }: FilterBarProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const collapsible = !!collapseLabel;
  const body = (
    <div
      id={collapsible ? panelId : undefined}
      data-slot="ds-filter-bar-body"
      data-open={collapsible ? open : undefined}
      className={cn('flex-wrap items-center justify-between gap-2', collapsible ? (open ? 'flex' : 'hidden sm:flex') : 'flex')}
    >
      {leading ? <div className="flex min-w-0 flex-wrap items-center gap-2">{leading}</div> : null}
      {trailing ? <div className="flex flex-wrap items-center gap-2">{trailing}</div> : null}
    </div>
  );
  return (
    <div data-slot="ds-filter-bar" role="group" aria-label={rest['aria-label']} className={cn('flex flex-col gap-2', className)}>
      {collapsible ? (
        <Button
          type="button"
          variant="secondary"
          className="self-start sm:hidden"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((v) => !v)}
        >
          {activeCount > 0 ? `${collapseLabel} · ${activeCount}` : collapseLabel}
        </Button>
      ) : null}
      {body}
    </div>
  );
}
