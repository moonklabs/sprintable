'use client';

import { Tabs as TabsPrimitive } from '@base-ui/react/tabs';
import { cn } from '@/lib/utils';
import { BIG_TAB_ACTIVE_DATA, BIG_TAB_BASE } from './tab-style';

/**
 * story 5048 T0 ②b — BigTabs: 키트의 «큰 제목 탭»(24 Semibold 제목이 곧 탭 · 고른 것 = 본문 글자색 · 나머지 = 셋째 글자색). 뿌리(`Tabs`) · 패널(`TabsContent`)은 ds `Tabs`를 그대로 쓴다.
 * 화살표 키 이동 · `aria-selected` · 패널 연결은 Base UI 몫이다.
 */
export type BigTabsListProps = Omit<TabsPrimitive.List.Props, 'className'> & { className?: string };

export function BigTabsList({ className, ...props }: BigTabsListProps) {
  return <TabsPrimitive.List data-slot="ds-big-tabs-list" className={cn('flex items-center gap-ds-4 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden', className)} {...props} />;
}

export type BigTabsTriggerProps = Omit<TabsPrimitive.Tab.Props, 'className'> & { className?: string };

export function BigTabsTrigger({ className, ...props }: BigTabsTriggerProps) {
  return <TabsPrimitive.Tab data-slot="ds-big-tabs-trigger" className={cn(BIG_TAB_BASE, BIG_TAB_ACTIVE_DATA, className)} {...props} />;
}
