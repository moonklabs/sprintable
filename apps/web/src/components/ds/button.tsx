'use client';

import { Children, cloneElement, Fragment, isValidElement, type MouseEvent, type ReactElement, type ReactNode } from 'react';
import { Button as ButtonPrimitive } from '@base-ui/react/button';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';
import { Icon } from './icon';

/**
 * UI-3(a9d56577) 새 Button — doc ui3-token-names-and-component-list-v0 §4 #1. 변형 넷(주 · 보조 · 조용 · 위험) × 크기 둘(28 · 36).
 * 상태: 호버 · 눌림 · 초점(2px action 링) · 비활성(점선 윤곽 + 글 ink-3) · 로딩(글 유지 + 도는 아이콘 · 눌러도 안 간다).
 * 위험은 «모양»만 — 확인 한 단계는 호출부가 Dialog로 붙인다. 폰은 누름 영역이 44 이상(보이는 크기와 무관).
 */
export const buttonVariants = cva(
  [
    'inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-ds-control border font-semibold',
    'transition-[filter,background-color] duration-(--ds-duration-fast) motion-reduce:transition-none outline-none',
    'focus-visible:ring-2 focus-visible:ring-ds-action focus-visible:ring-offset-1 focus-visible:ring-offset-ds-background',
    'active:brightness-90 disabled:pointer-events-none disabled:border-dashed disabled:border-ds-line-control disabled:bg-transparent disabled:text-ds-ink-3 disabled:brightness-100',
    // asChild(링크 등)는 native :disabled가 없다 — aria-disabled가 같은 «비활성» 모양을 입는다.
    'aria-disabled:pointer-events-none aria-disabled:border-dashed aria-disabled:border-ds-line-control aria-disabled:bg-transparent aria-disabled:text-ds-ink-3 aria-disabled:brightness-100',
    'aria-busy:pointer-events-none touch:min-h-ds-touch touch:min-w-ds-touch',
  ],
  {
    variants: {
      variant: {
        primary: 'border-ds-action bg-ds-action text-ds-on-action hover:brightness-95',
        secondary: 'border-ds-line-control bg-transparent text-ds-ink hover:bg-ds-surface-high',
        quiet: 'border-transparent bg-transparent text-ds-ink-2 hover:bg-ds-surface-high hover:text-ds-ink',
        danger: 'border-ds-failed bg-transparent text-ds-failed hover:bg-ds-failed-soft',
      },
      size: {
        md: 'h-ds-control-sm px-3 text-ds-small',
        lg: 'h-ds-control px-4 text-ds-body',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

type ButtonBase = Omit<ButtonPrimitive.Props, 'children' | 'onClick'> & VariantProps<typeof buttonVariants> & {
  /** 불러오는 중 — 글은 그대로 두고 앞에 도는 아이콘, `aria-busy`, 눌러도 아무 일도 없다(asChild의 자식 onClick도 막는다). */
  loading?: boolean;
  /** 글 앞 아이콘(Material Symbols 이름은 `Icon`에서). */
  iconStart?: ReactNode;
  onClick?: (event: MouseEvent<HTMLElement>) => void;
};

/** asChild면 자식은 «요소 하나»(링크 등 — Fragment · 글 불가): 같은 모양 · 상태를 입히고, 자식 onClick은 불러오는 중 · 비활성이면 불리지 않는다. */
export type ButtonProps = ButtonBase & ({ asChild?: false; children?: ReactNode } | { asChild: true; children: ReactElement });

export function Button({ className, variant, size, loading = false, iconStart, asChild = false, children, disabled, onClick, ...props }: ButtonProps) {
  const cls = cn(buttonVariants({ variant, size }), className);
  const blocked = loading || !!disabled;
  const spinner = loading ? <Icon name="progress_activity" size={14} spin /> : iconStart;

  if (asChild) {
    const child = Children.only(children);
    // Fragment는 props를 받지 못해 가드가 새므로 거부한다(타입도 요소만 받는다).
    if (!isValidElement(child) || child.type === Fragment) return null;
    const el = child as ReactElement<{ className?: string; onClick?: (e: MouseEvent<HTMLElement>) => void; children?: ReactNode } & Record<string, unknown>>;
    // 자식 요소(링크 등)는 disabled 속성이 없다 — 비활성 · 불러오는 중이면 aria-disabled + 초점 밖 + 클릭 무시로 «눌려도 아무 일도 없게» 만든다(자식 자신의 onClick도).
    return cloneElement(
      el,
      {
        ...(props as Record<string, unknown>),
        'data-slot': 'ds-button',
        className: cn(cls, el.props.className),
        'aria-busy': loading || undefined,
        'aria-disabled': blocked || undefined,
        'data-disabled': disabled ? '' : undefined,
        tabIndex: blocked ? -1 : el.props.tabIndex,
        onClick: (e: MouseEvent<HTMLElement>) => {
          if (blocked) {
            e.preventDefault();
            return;
          }
          el.props.onClick?.(e);
          onClick?.(e);
        },
      },
      <>
        {spinner}
        {el.props.children}
      </>,
    );
  }

  return (
    <ButtonPrimitive
      data-slot="ds-button"
      className={cls}
      disabled={disabled}
      aria-busy={loading || undefined}
      onClick={(e) => {
        // 불러오는 중에는 눌러도 아무 일도 없다(CSS pointer-events만 믿지 않는다 — 키보드 · 프로그램 클릭도 막는다).
        if (loading) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
      {...props}
    >
      {spinner}
      {children}
    </ButtonPrimitive>
  );
}
