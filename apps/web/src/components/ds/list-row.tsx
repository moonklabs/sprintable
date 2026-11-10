'use client';

import { Children, cloneElement, Fragment, isValidElement, type HTMLAttributes, type ReactElement, type ReactNode } from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cn } from '@/lib/utils';

type ListRowBase = Omit<HTMLAttributes<HTMLElement>, 'title'> & {
  /** 앞 자리(Avatar 등). */
  leading?: ReactNode;
  /** 둘째 줄(고정폭) — 시각 · 번호 · 한 마디. */
  subtitle?: ReactNode;
  /** 오른쪽 행동 · 상태(Button · Chip …). */
  trailing?: ReactNode;
  selected?: boolean;
  /** 줄 높이 — 기본 56, `compact` 36(236px 레일 같은 좁은 목록). 폰(coarse 포인터)은 둘 다 누름 영역 44 이상. */
  density?: 'default' | 'compact';
};
type ListRowNeeds = { needsHand?: false; needsHandLabel?: never } | { needsHand: true; /** 화면에 안 보이는 이름(예: «내 손이 필요»). 막대 색만으로 뜻을 싣지 않는다. */ needsHandLabel: string };
type ListRowShape =
  | { asChild?: false; title: ReactNode }
  /** 링크 · 단추 요소를 그대로 줄로 쓴다(자식 하나 — 자식 안에서 제목을 그린다). */
  | { asChild: true; title?: never; children: ReactElement };

export type ListRowProps = ListRowBase & ListRowNeeds & ListRowShape;

/**
 * UI-3(a9d56577) ListRow — doc §4 #8. 최소 높이 56 · 앞 자리 + 제목 둘째 줄 + 오른쪽 행동. 호버 · 선택 · 손 필요.
 * 줄 전체가 누를 수 있으면 `asChild`로 링크 · 단추 요소를 줄로 쓰고, 오른쪽 행동은 따로 눌린다.
 */
export function ListRow({ leading, title, subtitle, trailing, needsHand = false, needsHandLabel, selected = false, density = 'default', asChild = false, className, children, ...props }: ListRowProps) {
  // Fragment는 props를 받지 못해 모양 · 의미가 새므로 거부한다(타입도 요소만 받는다).
  if (asChild && (!isValidElement(children) || children.type === Fragment)) return null;
  const Comp = asChild ? Slot : 'div';
  const needsHandCue = needsHand && needsHandLabel ? <span className="sr-only">{needsHandLabel}</span> : null;
  // asChild: 자식 요소가 자기 안에서 줄을 그린다 — 손 필요 이름은 그 자식 안 맨 앞에 끼워 넣는다(막대 색만으로 뜻을 싣지 않는다).
  const slotted = asChild && isValidElement(children)
    ? cloneElement(Children.only(children) as ReactElement<{ children?: ReactNode }>, undefined, needsHandCue, (children as ReactElement<{ children?: ReactNode }>).props.children)
    : children;
  const body = (
    <>
      {needsHandCue}
      {leading ? <div className="shrink-0">{leading}</div> : null}
      <div className="min-w-0 flex-1">
        <div className="truncate text-ds-body font-semibold text-ds-ink">{title}</div>
        {subtitle ? <div className="truncate font-mono text-ds-mono-md text-ds-ink-3">{subtitle}</div> : null}
      </div>
      {trailing ? <div className="flex shrink-0 items-center gap-2">{trailing}</div> : null}
    </>
  );
  return (
    <Comp
      data-slot="ds-list-row"
      data-needs-hand={needsHand || undefined}
      data-density={density}
      aria-current={selected || undefined}
      className={cn(
        'relative flex items-center gap-3 border-b border-ds-line px-4 text-left outline-none transition-colors duration-100 motion-reduce:transition-none',
        'hover:bg-ds-surface-high focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ds-action',
        density === 'compact' ? 'min-h-9 py-1 pointer-coarse:min-h-11' : 'min-h-14 py-2',
        selected && 'bg-ds-surface-high',
        needsHand && 'before:absolute before:inset-y-0 before:left-0 before:w-1 before:bg-ds-needs-hand-bar',
        className,
      )}
      {...props}
    >
      {asChild ? (slotted as ReactNode) : body}
    </Comp>
  );
}
