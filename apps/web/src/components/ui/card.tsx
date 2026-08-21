'use client';

/**
 * Card 단일 프리미티브 — story #2877(S1a, UI/UX 갈아엎기 시퀀스 S1). button.tsx의 cva 패턴을
 * 그대로 따른다. SectionCard(surface=solid, 32 사용)·GlassPanel(surface=glass, 2 사용)은
 * 이 variant 체계의 얇은 alias로 재정의된다(하위호환·회귀 0) — 새 화면은 Card를 직접 쓴다.
 */

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

export const cardVariants = cva('border text-card-foreground', {
  variants: {
    surface: {
      solid: 'border-border/80 bg-card shadow-sm',
      glass: 'border-border/80 bg-card/95 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-card/88',
      subtle: 'border-border/60 bg-muted/30',
      plain: 'border-border/80 bg-card',
    },
    radius: {
      card: 'rounded-2xl',
      compact: 'rounded-xl',
      inline: 'rounded-lg',
    },
  },
  defaultVariants: { surface: 'solid', radius: 'card' },
});

export interface CardProps extends React.ComponentProps<'div'>, VariantProps<typeof cardVariants> {}

export function Card({ className, surface, radius, ...props }: CardProps) {
  return (
    <div
      data-slot="card"
      className={cn(cardVariants({ surface, radius, className }))}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-header"
      className={cn('border-b border-border/80 px-5 py-4 sm:px-6', className)}
      {...props}
    />
  );
}

export function CardBody({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-body"
      className={cn('px-5 py-4 sm:px-6', className)}
      {...props}
    />
  );
}

export function CardFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-footer"
      className={cn('border-t border-border/80 px-5 py-4 sm:px-6', className)}
      {...props}
    />
  );
}
