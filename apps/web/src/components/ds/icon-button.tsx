'use client';

import { Button as ButtonPrimitive } from '@base-ui/react/button';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';
import { Icon, type IconName } from './icon';

const iconButtonVariants = cva(
  [
    'inline-flex shrink-0 select-none items-center justify-center rounded-ds-control border border-transparent bg-transparent text-ds-ink-2 outline-none',
    'transition-[filter,background-color] duration-100 motion-reduce:transition-none hover:bg-ds-surface-high hover:text-ds-ink',
    'focus-visible:ring-2 focus-visible:ring-ds-action focus-visible:ring-offset-1 focus-visible:ring-offset-ds-background',
    'active:brightness-90 disabled:pointer-events-none disabled:text-ds-ink-3 pointer-coarse:min-h-11 pointer-coarse:min-w-11',
  ],
  {
    variants: { size: { md: 'size-7', lg: 'size-9' } },
    defaultVariants: { size: 'md' },
  },
);

export interface IconButtonProps extends Omit<ButtonPrimitive.Props, 'children' | 'aria-label'>, VariantProps<typeof iconButtonVariants> {
  /** 글자가 없는 단추라 접근성 이름이 필수다(없으면 컴파일 에러). */
  label: string;
  icon: IconName;
}

export function IconButton({ label, icon, size, className, ...props }: IconButtonProps) {
  return (
    <ButtonPrimitive data-slot="ds-icon-button" aria-label={label} title={label} className={cn(iconButtonVariants({ size }), className)} {...props}>
      <Icon name={icon} size={size === 'lg' ? 18 : 16} />
    </ButtonPrimitive>
  );
}
