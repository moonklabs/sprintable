import * as React from 'react';
import { cn } from '@/lib/utils';
import { cardVariants } from '@/components/ui/card';

/**
 * story #2877 — Card 프리미티브(surface=glass)의 얇은 alias(하위호환·회귀 0). 기존
 * 2개 소비처는 이 컴포넌트를 그대로 계속 쓴다 — 스타일 SSOT는 cardVariants로 이관됐다.
 */
export function GlassPanel({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="glass-panel"
      className={cn(cardVariants({ surface: 'glass', radius: 'card' }), className)}
      {...props}
    />
  );
}
