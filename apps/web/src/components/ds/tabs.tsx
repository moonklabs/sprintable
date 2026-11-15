'use client';

import { Tabs as TabsPrimitive } from '@base-ui/react/tabs';
import { cn } from '@/lib/utils';
import { TAB_ACTIVE_DATA, TAB_BASE, TAB_RULE, TAB_STRIP } from './tab-style';

export type TabsProps = Omit<TabsPrimitive.Root.Props, 'className'> & { className?: string };

/** UI-3(a9d56577) Tabs — 같은 화면 안에서 칸(패널)을 갈아 보이는 탭. 화살표 키 이동 · `aria-selected` · 패널 연결은 Base UI 몫이다. 다른 화면으로 가는 탭줄은 `TabNav`. */
export function Tabs({ className, ...props }: TabsProps) {
  return <TabsPrimitive.Root data-slot="ds-tabs" className={cn('flex flex-col', className)} {...props} />;
}

export type TabsListProps = Omit<TabsPrimitive.List.Props, 'className'> & { className?: string };

/** 탭 줄 — 아래 선 + 가로 스크롤. 줄의 접근성 이름(`aria-label`)을 주는 게 좋다(화면에 탭줄이 둘 이상일 때 구분). */
export function TabsList({ className, ...props }: TabsListProps) {
  return (
    <div className={TAB_RULE}>
      <TabsPrimitive.List data-slot="ds-tabs-list" className={cn(TAB_STRIP, className)} {...props} />
    </div>
  );
}

export type TabsTriggerProps = Omit<TabsPrimitive.Tab.Props, 'className'> & { className?: string };

export function TabsTrigger({ className, ...props }: TabsTriggerProps) {
  return <TabsPrimitive.Tab data-slot="ds-tabs-trigger" className={cn(TAB_BASE, TAB_ACTIVE_DATA, className)} {...props} />;
}

export type TabsContentProps = Omit<TabsPrimitive.Panel.Props, 'className'> & { className?: string };

export function TabsContent({ className, ...props }: TabsContentProps) {
  return <TabsPrimitive.Panel data-slot="ds-tabs-content" className={cn('outline-none focus-visible:ring-2 focus-visible:ring-ds-action', className)} {...props} />;
}
