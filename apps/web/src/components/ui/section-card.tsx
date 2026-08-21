import * as React from 'react';
import { cn } from '@/lib/utils';
import { cardVariants, CardHeader, CardBody } from '@/components/ui/card';

/**
 * story #2877 — Card 프리미티브(surface=solid)의 얇은 alias(하위호환·회귀 0). 기존
 * 32개 소비처는 이 컴포넌트를 그대로 계속 쓴다 — 스타일 SSOT는 cardVariants로 이관됐다.
 */
export function SectionCard({ className, ...props }: React.ComponentProps<'section'>) {
  return (
    <section
      data-slot="section-card"
      className={cn(cardVariants({ surface: 'solid', radius: 'card' }), className)}
      {...props}
    />
  );
}

export const SectionCardHeader = CardHeader;
export const SectionCardBody = CardBody;
