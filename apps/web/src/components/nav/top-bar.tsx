'use client';

import { cn } from '@/lib/utils';
import { NotificationBell } from './notification-bell';
import { WhatsNewButton } from '@/components/release-notes/whats-new-button';
import { PresenceToggleButton } from '@/components/presence/team-presence-toggle';
import { useTopBar } from './top-bar-context';
import { ContextSwitcherChip } from './context-switcher-chip';
import type { OrgSwitcherItem } from './unified-switcher';

interface TopBarProps {
  className?: string;
  // story #2076 — <1024 컨텍스트 칩(조직/프로젝트 전환). AppSidebar와 같은 이유로 훅 대신
  // props로 받는다(dashboard-shell.tsx가 이 트리 전체의 provider라 그 안에서 useDashboardContext를
  // 다시 소비하면 파일 간 순환 import가 생긴다 — AppSidebar가 이미 같은 패턴).
  orgId?: string;
  orgMemberships?: OrgSwitcherItem[];
  projectId?: string;
  projectMemberships?: Array<{ projectId: string; projectName: string }>;
}

export function TopBar({ className, orgId, orgMemberships = [], projectId, projectMemberships = [] }: TopBarProps) {
  const { title, actions, hidden, showContextChip } = useTopBar();
  return (
    <div
      className={cn(
        'flex h-12 shrink-0 items-center gap-2 border-b px-4',
        'sticky top-0 z-30 bg-background transition-transform',
        '[transition-duration:var(--gnb-hide-duration)]',
        '[transition-timing-function:var(--gnb-hide-easing)]',
        hidden && '-translate-y-full',
        className,
      )}
    >
      {/* story #1958: 모바일 햄버거 트리거 제거 — 하단 탭바(MobileTabBar)가 <1024 내비게이션을
          대신한다(blueprint §3.2 "모바일 사이드바 Sheet/햄버거 폐기" 방향, 오르테가군 확定).
          story #2076: 그 자리에 컨텍스트 칩을 추가한다 — 탭바는 화면 이동, 칩은 컨텍스트(조직/
          프로젝트) 전환으로 관심사가 다르다. title보다 먼저 두어 "지금 어디에 있는지"가 화면
          제목보다 앞서 보이게 한다.
          근본 재구현(2076 회귀 후속, 유나양 규격): 기본 숨김·표시할 루트 화면만 showContextChip
          으로 명시 — "숨길 것 명시" 방식이 새 상세 화면마다 빠뜨리는 fail-open이었던 것을
          "표시할 것만 명시·기본 숨김"으로 뒤집었다(상세 화면은 이미 뒤로가기로 맥락이 있다). */}
      {showContextChip && (
        <ContextSwitcherChip
          orgs={orgMemberships}
          currentOrgId={orgId}
          projects={projectMemberships}
          currentProjectId={projectId}
        />
      )}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {title}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {actions}
        {/* 2505d27d: presence 패널 토글(선생님 결정·FAB 대체) — Bell 옆·working-count 배지 */}
        <PresenceToggleButton />
        <WhatsNewButton />
        <NotificationBell />
      </div>
    </div>
  );
}
