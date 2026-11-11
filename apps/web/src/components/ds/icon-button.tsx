'use client';

import { Button as ButtonPrimitive } from '@base-ui/react/button';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';
import { Icon, type IconName } from './icon';

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
        primary: 'border-ds-action bg-ds-action text-ds-on-action hover:bg-ds-action hover:text-ds-on-action hover:brightness-95 disabled:border-dashed disabled:border-ds-line-control disabled:bg-transparent disabled:brightness-100 aria-disabled:border-dashed aria-disabled:border-ds-line-control aria-disabled:bg-transparent aria-disabled:brightness-100',
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

export function IconButton({ label, icon, size, variant, className, ...props }: IconButtonProps) {
  return (
    <ButtonPrimitive data-slot="ds-icon-button" aria-label={label} title={label} className={cn(iconButtonVariants({ variant, size }), className)} {...props}>
      <Icon name={icon} size={size === 'xl' ? 22 : size === 'lg' ? 18 : 16} />
    </ButtonPrimitive>
  );
}
