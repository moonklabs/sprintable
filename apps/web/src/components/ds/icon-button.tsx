'use client';

import { Button as ButtonPrimitive } from '@base-ui/react/button';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';
import { ARIA_DISABLED_FACE, DISABLED_FACE } from './disabled-face';
import { Icon, type IconName, type IconSize } from './icon';

const iconButtonVariants = cva(
  [
    'inline-flex shrink-0 select-none items-center justify-center rounded-ds-control border border-transparent bg-transparent text-ds-ink-2 outline-none',
    'transition-[filter,background-color] duration-(--ds-duration-fast) motion-reduce:transition-none hover:bg-ds-surface-high hover:text-ds-ink',
    'focus-visible:ring-2 focus-visible:ring-ds-action focus-visible:ring-offset-1 focus-visible:ring-offset-ds-background',
    'active:brightness-90 disabled:pointer-events-none disabled:text-ds-ink-3 aria-disabled:pointer-events-none aria-disabled:text-ds-ink-3 touch:min-h-ds-touch touch:min-w-ds-touch',
  ],
  {
    variants: {
      /** `quiet` 글자 없는 보조 단추 · `primary` 화면의 주 행동 하나(떠 있는 새 대화 단추 등 — 한 화면에 하나). */
      variant: {
        quiet: '',
        primary: `border-ds-action bg-ds-action text-ds-on-action hover:bg-ds-action hover:text-ds-on-action hover:brightness-95 disabled:brightness-100 aria-disabled:brightness-100 ${DISABLED_FACE} ${ARIA_DISABLED_FACE}`,
      },
      size: { md: 'size-ds-control-sm', lg: 'size-ds-control', xl: 'size-ds-control-xl' },
    },
    defaultVariants: { variant: 'quiet', size: 'md' },
  },
);

export interface IconButtonProps extends Omit<ButtonPrimitive.Props, 'children' | 'aria-label'>, VariantProps<typeof iconButtonVariants> {
  /** 글자가 없는 단추라 접근성 이름이 필수다(없으면 컴파일 에러). */
  label: string;
  icon: IconName;
}

/** 단추 크기별 안쪽 아이콘 단계 — 한 표(story 5048 ④ PO 11-27). md · lg는 높이 40 하나(40 높이 조작 = md 20) · xl 48 큰 아이콘 단추 = lg 24. 전에는 16 · 18 · 22를 숫자로 줬다. */
const ICON_BUTTON_STEP = { md: 'md', lg: 'md', xl: 'lg' } as const satisfies Record<'md' | 'lg' | 'xl', IconSize>;

export function IconButton({ label, icon, size, variant, className, ...props }: IconButtonProps) {
  return (
    <ButtonPrimitive data-slot="ds-icon-button" aria-label={label} title={label} className={cn(iconButtonVariants({ variant, size }), className)} {...props}>
      <Icon name={icon} size={ICON_BUTTON_STEP[size ?? 'md']} />
    </ButtonPrimitive>
  );
}
