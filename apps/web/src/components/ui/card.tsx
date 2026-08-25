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
      // story #2969 §2 PR-2(doc proofline-system-layer-2969) — solid는 인라인 표면(§1.2)이라
      // shadow-sm 제거·hairline(기존 border-border/80)만으로 경계. glass는 §2 C행에서
      // "정책 검토"로 별도 보류된 축(glass-panel.tsx 소비처 2곳·이 PR 범위 밖)이라 무변경.
      solid: 'border-border/80 bg-card',
      glass: 'border-border/80 bg-card/95 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-card/88',
      subtle: 'border-border/60 bg-muted/30',
      plain: 'border-border/80 bg-card',
    },
    radius: {
      // story #2969 §1.1 — rounded-2xl(7.2px, PR-T 이후 값)은 "카드·인라인 표면에서 퇴역"
      // 대상(§1.1 명시)이라 크리스프 lg(4px)로.
      card: 'rounded-lg',
      compact: 'rounded-xl',
      inline: 'rounded-lg',
      // story #7d7634ee(P0·선생님 직접 지시) — radius=signature(컷코너 옵트인, §2969 §1.4)
      // 폐지. 실사용 0건이었고(전 코드베이스에서 radius="signature" 호출 자체가 없었다),
      // proof-cut 전면 처분 대상이라 대체 없이 제거한다.
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
