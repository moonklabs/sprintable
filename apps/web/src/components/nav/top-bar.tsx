'use client';

import { useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { LAYER } from '@/components/ds/layers';
import { NotificationBell } from './notification-bell';
import { WhatsNewButton } from '@/components/release-notes/whats-new-button';
import { PresenceToggleButton } from '@/components/presence/team-presence-toggle';
import { useTopBar } from './top-bar-context';
import { ContextSwitcherChip } from './context-switcher-chip';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { useIsTablet } from '@/hooks/use-mobile';
import { IconButton } from '@/components/ds/icon-button';
import { useCommandPaletteOpener } from '@/components/command-palette/command-palette-context';
import { TopBarPath, useTopBarCrumbs } from './top-bar-path';
import { TopBarSearch } from './top-bar-search';
import { desktopApp } from '@/lib/desktop-app';
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
  /** story #3146(doc mobile-switcher-redesign-spec-4758744a §③ 계정층) — ContextSwitcherChip
   * 시트의 계정 전환 섹션 활성화 여부(없으면 그 섹션 자체를 생략). 위 orgId 주석과 동일
   * 이유로 훅이 아니라 prop으로 받는다. */
  userName?: string;
}

const noopSubscribe = () => () => {};

export function TopBar({ className, orgId, orgMemberships = [], projectId, projectMemberships = [], userName }: TopBarProps) {
  const { title, actions, hidden, showContextChip } = useTopBar();
  const t = useTranslations('nav');
  const isTablet = useIsTablet();
  // story 5031 (C1 step 4, PO 11-26): with the phone tab bar at four places there is no «전체» tab — the way to every other screen is the palette (⌘K on a desktop; here the same door, drawn below lg only). No provider (a test of the bar alone) = no button.
  const openPalette = useCommandPaletteOpener();
  // story 5031 (C1 step 5a): inside the desktop app the whole strip is the window's drag area (globals.css `[data-desktop-app]` rules: the strip drags, every pressable inside does not). Read after hydration — the server does not know the app.
  const inDesktopApp = useSyncExternalStore(noopSubscribe, () => desktopApp() !== undefined, () => false);
  const crumbs = useTopBarCrumbs({ orgId, orgMemberships, projectId, projectMemberships, title });
  return (
    <div
      data-testid="top-bar"
      data-desktop-app={inDesktopApp ? '' : undefined}
      className={cn(
        // story #4277(유나 판단 ②) — 컨테이너 쿼리 기준(칩의 태블릿 바닥 @[40rem]:min-w-[7.5rem]가 이 막대 폭을 본다).
        // story 5031 (5a): from lg the bar is three zones — path · search · buttons — and 64 high (h-ds-bar) with its bottom border inside (border-box).
        '@container flex h-12 shrink-0 items-center gap-2 border-b px-4 lg:h-ds-bar lg:gap-ds-4',
        // 4913 — 쪽 바탕 층(LAYER.page = ds-background): 막대는 화면과 같은 바탕 위에 서야 한다(옛 bg-background는 따뜻한 옛 바탕이라 새 바탕과 색이 어긋남).
        'sticky top-0 z-30 transition-transform', LAYER.page,
        '[transition-duration:var(--gnb-hide-duration)]',
        '[transition-timing-function:var(--gnb-hide-easing)]',
        // [SID:4288] 스크롤로 숨은 채 Tab 초점이 들어오면 다시 보인다(보이지 않는 초점 0 · 내용은 늘 닿아야 해서 inert가 아님).
        hidden && '-translate-y-full focus-within:translate-y-0',
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
          userName={userName}
        />
      )}
      {/* story 6df91dce — 390px에서 title(현재 탭 이름, 예 "결재함")이 contextChip+actions와
          폭 경합에 밀려 글자 단위로 세로 꺾이던 결함(선생님 폰 첫 화면 "결/재/함"). title 슬롯은
          <h1 className="text-sm font-medium">{...}</h1> 패턴이 인박스·rewards·chats·more·goals·
          standup·sprints·docs 등 10+ 화면 공통이라 각 caller가 아니라 이 렌더러(슬롯 소비처)에서
          단일 정의로 막는다 — 직계 자식(title)에 min-w-0+truncate를 걸어 flex 안에서 줄바꿈 대신
          한 줄 말줄임으로 degrade. sidebar.tsx의 [&>span:last-child]:truncate와 동일 관례. */}
      {/* story #4277(민 기기 6번) — flex-1(기준 폭 0)이면 제목은 «남는 폭»만 받아, 칩 · 액션이 다 차면 짧은 제목(«실행»)도 «실.»로 잘렸다.
          flex-auto(기준 폭 = 제목 글자 폭)로 — 줄 폭이 모자라면 기준 폭이 큰 컨텍스트 칩(최대 190px · 이제 shrink)이 대부분을 양보하고, 제목은
          긴 경우에만 말줄임. 데스크톱(칩 없음)은 전과 같이 남는 폭을 채운다.
          «칩이 먼저 · 제목은 칩이 최소 폭(44px)에 닿은 뒤에» 우선순위는 칩 쪽 shrink-[10000]이 맡는다(칩 파일 주석). 제목 shrink는 기본 1로 둔다 —
          1 미만(예: 0.001)이면 flex 규칙상(줄어들 항목들의 shrink 합이 1 미만이면 부족분에 그 합을 곱해 일부만 줄인다) 칩이 바닥에 닿은 뒤에도
          제목이 거의 안 줄어 넘쳤다(스토리지 상단바 420/402 실측). */}
      {/* story 5031 (5a): the LEFT zone — below lg `contents` (the title is a direct child of the bar exactly as before); from lg the path (org › project-or-place) then the title as the path's last crumb. The title keeps its own element (an h1 where the screen made it one). */}
      <div data-testid="top-bar-left" className="contents lg:flex lg:min-w-0 lg:flex-1 lg:basis-0 lg:items-center lg:gap-ds-2">
        <TopBarPath crumbs={crumbs} />
        <div
          data-testid="top-bar-title"
          className={cn(
            'flex min-w-0 flex-auto items-center gap-2 [&>*]:min-w-0 [&>*]:truncate',
            // the separator before the title is drawn only when a crumb comes before it and the title drew something (a title component that renders nothing leaves the wrapper empty)
            crumbs.length > 0 && "lg:not-empty:before:shrink-0 lg:not-empty:before:text-ds-ink-3 lg:not-empty:before:content-['›']",
          )}
        >
          {title}
        </div>
      </div>
      {/* story 5031 (5a): the MIDDLE zone — the field that opens ⌘K (grows twice as fast as the sides until its 480 cap, so the field is as wide as the room allows and the two sides stay equal → it is centred) (lg up; below lg the icon in the right zone is the door). No palette provider (a test of the bar alone) = no field. */}
      {openPalette ? (
        <div data-testid="top-bar-center" className="hidden min-w-0 lg:block lg:max-w-120 lg:flex-2 lg:basis-0">
          <TopBarSearch onOpen={openPalette} />
        </div>
      ) : null}
      <div data-testid="top-bar-right" className="flex shrink-0 items-center gap-1 lg:min-w-fit lg:flex-1 lg:basis-0 lg:justify-end">
        {actions}
        {openPalette ? (
          <span className="contents lg:hidden">
            <IconButton icon="search" label={t('search')} onClick={openPalette} data-testid="top-bar-search" />
          </span>
        ) : null}
        {/* 2505d27d: presence 패널 토글(선생님 결정·FAB 대체) — Bell 옆·working-count 배지.
            story 4890 (UI-7 · 폰 머리줄): 탭 바가 있는 폭(<lg)의 머리줄은 «칩 · 제목 · 알림» 하나로 — 팀 현황 · 새 소식은 «전체» 맨 위 두 줄로 옮겼다(손가락 폭 아이콘 셋이 한 줄에 몰리던 것). 탭 바 없는 폭(lg+)은 그대로. */}
        <span className="hidden lg:contents"><PresenceToggleButton /></span>
        <span className="hidden lg:contents"><WhatsNewButton /></span>
        <NotificationBell />
      </div>
    </div>
  );
}
