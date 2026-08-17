'use client';

import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { NotificationBell } from './notification-bell';
import { WhatsNewButton } from '@/components/release-notes/whats-new-button';
import { PresenceToggleButton } from '@/components/presence/team-presence-toggle';
import { useTopBar } from './top-bar-context';
import { ContextSwitcherChip } from './context-switcher-chip';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { useIsTablet } from '@/hooks/use-mobile';
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
  const t = useTranslations('nav');
  const isTablet = useIsTablet();
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
      {/* story #2683(모바일 IA S3) — settings/page.tsx 안에만 있던 전역 GNB 유일문
          (SidebarTrigger)을 폐기하며(AC1), 태블릿(768~1023, doc §2.6① PO 승인 권고로 Sheet
          GNB 존치)만 새 문을 여기 둔다. 폰(<768)은 문이 없다 — /more 허브(S2)가 이미 전
          목적지를 2탭으로 커버해 Sheet GNB 자체가 불필요(doc 판별자). useIsTablet()은 JS
          판정이라 `md:` Tailwind 브레이크포인트 신규 사용 금지 규율을 건드리지 않는다. */}
      {isTablet && (
        <SidebarTrigger aria-label={t('openGlobalNav')} />
      )}
      {showContextChip && (
        <ContextSwitcherChip
          orgs={orgMemberships}
          currentOrgId={orgId}
          projects={projectMemberships}
          currentProjectId={projectId}
        />
      )}
      {/* story 6df91dce — 390px에서 title(현재 탭 이름, 예 "결재함")이 contextChip+actions와
          폭 경합에 밀려 글자 단위로 세로 꺾이던 결함(선생님 폰 첫 화면 "결/재/함"). title 슬롯은
          <h1 className="text-sm font-medium">{...}</h1> 패턴이 인박스·rewards·chats·more·goals·
          standup·sprints·docs 등 10+ 화면 공통이라 각 caller가 아니라 이 렌더러(슬롯 소비처)에서
          단일 정의로 막는다 — 직계 자식(title)에 min-w-0+truncate를 걸어 flex 안에서 줄바꿈 대신
          한 줄 말줄임으로 degrade. sidebar.tsx의 [&>span:last-child]:truncate와 동일 관례. */}
      <div className="flex min-w-0 flex-1 items-center gap-2 [&>*]:min-w-0 [&>*]:truncate">
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
