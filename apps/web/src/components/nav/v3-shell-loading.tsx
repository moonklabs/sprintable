import type { ReactNode } from 'react';
import { NavV3Sidebar, type NavV3ItemKey } from '@/components/nav/nav-v3-item-list';
import type { NavV3Flags } from '@/lib/nav-v3-destinations';

/**
 * story #4274(까디르 검수 P2 · 유나 «스켈레톤 = 페이지 컨테이너») — v3 화면(오늘 · 대화 · 연결·규칙)의 loading.
 * 그 화면들은 셸(`v3-shell-root` · 왼쪽 NavV3Sidebar · 위 h-14 막대)을 화면 스스로 그려서, 공용 PageSkeleton만 두면 도착 때 셸 전체가
 * 튀었다. 같은 셸 뼈대(사이드바는 실물 · 막대는 같은 높이 자리) 안에 화면별 내용 컨테이너(children)를 둔다.
 */
export function V3ShellLoading({
  flags,
  activeKey,
  topbar,
  children,
}: {
  flags: NavV3Flags;
  activeKey: NavV3ItemKey;
  /** 화면이 위 막대(h-14)를 그리면 true(오늘 · 연결·규칙) · 대화는 막대 없음. */
  topbar: boolean;
  children: ReactNode;
}) {
  return (
    <div className="v3-shell-root flex h-screen min-h-0 flex-col bg-muted/20">
      <div className="flex min-h-0 flex-1">
        <NavV3Sidebar flags={flags} activeKey={activeKey} />
        <div className="flex min-w-0 flex-1 flex-col">
          {topbar ? <div className="h-14 shrink-0 border-b border-border bg-card" aria-hidden="true" /> : null}
          {children}
        </div>
      </div>
    </div>
  );
}
