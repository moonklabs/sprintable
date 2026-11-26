'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { CommandPalette } from '@/components/command-palette/command-palette';
import { findActiveStaticItemId, isResourceItemActive } from '@/lib/nav-active';
import { isRealShortcut } from '@/lib/keyboard-shortcuts';
import { useCommandPalette } from '@/components/command-palette/command-palette-context';
import { MoveAgentsEntry, NewProjectEntry } from '@/components/nav/new-project-entry';
import { UnifiedSwitcher, type OrgSwitcherItem } from '@/components/nav/unified-switcher';
import { NavRow } from '@/components/nav/sidebar-nav-parts';
import { fetchDesignatedPendingCount, subscribeDesignatedPendingCount } from '@/lib/designated-pending-count-client';
import {
  CHAT_CENTER_ITEM,
  OTHER_NAV_ITEMS,
  resolveNavGroups,
} from '@/lib/nav-config';
import { depth1ForPath, listItemsForSlot, navItemRoute } from '@/lib/nav-depth1';
import { ROUTE_PLACEMENT } from '@/lib/nav-placement';
import { DEFAULT_NAV_V3_FLAGS, type NavV3Flags, scopedResourceHref } from '@/lib/nav-v3-destinations';
import { useSseMultiplexerContext } from '@/components/realtime-provider';
import { WORKSPACE_FRAME_TAB_PATHS } from '@/components/workspace/workspace-frame-tabs';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar';
import { useFlatHref } from '@/hooks/use-flat-href';

interface AppSidebarProps {
  orgId?: string;
  orgMemberships?: OrgSwitcherItem[];
  projectId?: string;
  // story a539c649 S2: 문서 바로가기가 /{ws}/{proj}/docs 직접 path 를 만드는 데만 쓴다 — 없으면
  // bare `/docs`로 폴백(미들웨어 리다이렉트 안전망이 받음).
  currentProjectSlug?: string;
  projectMemberships: Array<{ projectId: string; projectName: string }>;
  /** kept for the shell's call site: the account row moved to the icon bar's account popover (story 5031) */
  userName?: string;
  // story #2007(perf·서버부하): dashboard-shell.tsx가 단일 useChatUnreadTotal() 호출 결과를
  // prop으로 내려준다 — 여기서 직접 훅을 호출하면 MobileTabBar와 각자 SSE 연결을 열게 된다.
  chatUnreadTotal: number;
  // story #4003(E-UX-OVERHAUL·셸 통합 2/N) — (authenticated)/layout.tsx(서버)가 읽은
  // v3 플래그 3개. 이 컴포넌트는 'use client'라 process.env를 직접 못 읽는다.
  navV3Flags?: NavV3Flags;
}

// story 5031 (C1 step 2a) — the list column draws the rows of the ONE place you are in (홈 · 채팅 · 에이전트 · 설정): no zone headers, nothing to fold, no per-person fold memory (the old zones are gone from this column;
// every screen is still reached — the icon bar's four places, ⌘K «모든 화면», cards and panels; nav-placement.json is the table and nav-placement.test.ts keeps it «빠짐 0»).

export function AppSidebar({
  orgId,
  orgMemberships = [],
  projectId,
  currentProjectSlug,
  projectMemberships,
  chatUnreadTotal,
  navV3Flags = DEFAULT_NAV_V3_FLAGS,
}: AppSidebarProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // story #4885 — 새 셸은 플래그 없이 하나: 버전 플래그는 안 읽고, `desktopDownloadEnabled`(화면 존재 플래그)만 설정 묶음의 항목 유무를 정한다.
  const navGroups = useMemo(() => resolveNavGroups(navV3Flags), [navV3Flags]);
  // story #4226 — static(flat) 항목 링크는 `?p=`를 싣는다(use-flat-href · 셸의 착지 정규화 router.replace 0).
  const flatHref = useFlatHref();
  // story a539c649(S2 최초·S3 리소스 확장) — 실 ws/proj slug 있으면 직접 path(리다이렉트 홉
  // 절약) — 없으면 bare `/{resource}`(미들웨어의 bare→쿠키 default 해소 301 안전망이 받는다).
  const orgSlug = orgMemberships.find((o) => o.orgId === orgId)?.orgSlug;
  // story #3844(PO 지적 2026-09-14 07:53Z, 캡처 3 라이브 눈확認로 발견) — 「일감」(id
  // 'board') 항목이 resource='flow' 단일 경로만 알아 WorkspaceFrameTabs가 그 위에 얹은
  // 나머지 탭(work-list·sprints·epics·retro)에선 사이드바가 비활성으로 떨어졌다.
  // extraActivePaths로 WORKSPACE_FRAME_TAB_PATHS(SSOT, 하드코딩 0)를 함께 검사 — 탭을
  // 하나 늘리면 이 판정도 자동으로 늘어난다. href는 여전히 resource(주 진입점) 기준.
  function resourceLink(resource: string, extraActivePaths: readonly string[] = []): { href: string; isActive: boolean } {
    const href = scopedResourceHref(resource, orgSlug, currentProjectSlug, flatHref);
    const isActive = isResourceItemActive(pathname, resource, orgSlug, currentProjectSlug, extraActivePaths);
    return { href, isActive };
  }
  // story #2224(IA v2.2 §7-3, AC12) — 기본 진입은 /flow, 사이드바가 통합뷰를 가리킨다.
  // 칸반은 /flow?view=list로 흡수됐다(PR#2698, `/board` 라우트 자체는 삭제) — 사이드바에
  // board를 flow와 나란히 1Depth로 세우지 않는다("나란히 두면 「내렸다」가 무효가 된다" —
  // §7-3) — /flow 안의 보기 전환(?view=list)이 "내비 2Depth 이하" 요건을 충족하는 그 자리다.
  const flowLink = resourceLink('flow');
  // story #d986fd6c(IA·S4) — 정적 항목 active 판정. 원래 렌더 루프 바로 앞(구 위치)에
  // 있었으나, 활성 구역 계산(아래)이 접힘 state보다 먼저 알아야 해 이 자리로 옮겼다 —
  // pathname/href만의 순수 함수라 위치 이동에 따른 의미 변화 없음.
  // story #4885 (codex 1판) — 정적 항목의 «지금 여기» 판정 한 곳. 예전 isActive(href)는 쿼리 달린 경로(`/inbox?tab=gates`)를 pathname과 글자 그대로 비교해 영영 켜지지 않았고,
  // 접두 비교라 `/organization/workforce/runs`가 «에이전트»와 «실행 기록»을 함께 켜고 `/content/channel-posts`가 «블로그 포스트»와 «채널 포스트»를 함께 켰다.
  // 이제 lib/nav-active.ts 한 곳(아이콘 막대와 같은 판정): ① 쿼리는 경로와 따로 보고 ② 맞는 항목이 여럿이면 가장 구체적인 하나만 ③ 정확히 맞는 항목이 없으면 같은 화면의 가장 구체적인 항목(탭만 다른 경우).
  const activeStaticItemId = findActiveStaticItemId([CHAT_CENTER_ITEM, ...navGroups.flatMap((g) => g.items), ...OTHER_NAV_ITEMS], pathname, searchParams);

  // story 5031 — which of the four places this path belongs to, and that place's rows. A path the table does not know yet (a flat bare «/flow» that the proxy is about to forward) falls back to the place of the catalog row that is active for it, then to 홈.
  const catalogItems = useMemo(() => [CHAT_CENTER_ITEM, ...navGroups.flatMap((g) => g.items), ...OTHER_NAV_ITEMS], [navGroups]);
  const pathSlot = depth1ForPath(pathname);
  const activeCatalogItem = pathSlot ? undefined : catalogItems.find((item) => (
    item.kind === 'static' ? item.id === activeStaticItemId : resourceLink(item.path, item.id === 'board' ? WORKSPACE_FRAME_TAB_PATHS : []).isActive
  ));
  const itemSlot = activeCatalogItem ? ROUTE_PLACEMENT[navItemRoute(activeCatalogItem)]?.slot : undefined;
  const activeSlot = pathSlot ?? (itemSlot && itemSlot !== 'outside' ? itemSlot : 'home');
  const slotItems = useMemo(() => listItemsForSlot(catalogItems, activeSlot), [catalogItems, activeSlot]);
  // story 5035 (C5): a catalog screen that is NOT a row of its place's list column (the agents' «실행 기록» · «API 키» — they live in the «전체 보기» strip now) would light nothing here; its place's own row is lit instead (the same «more specific wins» rule, over the rows that are drawn).
  const shownActiveStaticItemId = slotItems.some((item) => item.id === activeStaticItemId) ? activeStaticItemId : findActiveStaticItemId(slotItems, pathname, searchParams);
  const t = useTranslations('nav');
  const { isMobile, setOpenMobile } = useSidebar();
  // ⌘K 액션 확장(story 4f991165) — 스토리 상세(`/flow?view=list&story={id}`)에서 열렸을
  // 때만 context 주입. story #2224 정정(2026-07-30): 옛 boardLink.isActive 대신
  // flowLink.isActive로 판정 — `/board`가 삭제돼 그 판정이 다시는 참이 될 수 없었다(칸반
  // 보기가 이제 /flow 경로이므로 옛 체크로는 위임 명령이 영영 안 뜨는 조용한 회귀였다).
  const contextStoryId = flowLink.isActive ? (searchParams.get('story') ?? undefined) : undefined;

  // 4dad38d3: 모바일 nav 아이템 선택 후 드로어 auto-close. route 변경 시 닫는다(전 아이템 DRY 커버).
  // 데스크탑은 isMobile 가드로 no-op·백드롭 탭 닫기(Sheet onOpenChange)는 무영향.
  useEffect(() => {
    if (isMobile) setOpenMobile(false);
  }, [pathname, isMobile, setOpenMobile]);

  // story #3762(유나 §定) — SidebarContent가 흔한 뷰포트(≤900px)보다 길어져(신뢰 이후
  // 구역이 스크롤해야 보인다, .scrollbar-visible로 어포던스는 확보) 딥링크/새로고침으로
  // 그 구역에 바로 들어와도 활성 항목이 화면 밖이면 여전히 못 찾는다 — 활성 경로가
  // 바뀔 때 그 항목만 뷰로 당겨온다. channels/page.tsx:1057과 동형(jsdom엔
  // scrollIntoView 자체가 없어 메서드까지 옵셔널 체이닝) — block:'nearest'(페이지
  // 자체는 안 흔들고 사이드바 내부만 스크롤, 'start'는 항목을 상단에 박아 불필요한 점프).
  const activeMenuItemRef = useRef<HTMLAnchorElement | null>(null);
  useEffect(() => {
    activeMenuItemRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [pathname]);

  // story #1981 — GNB 결재함 배지 semantic 교체: "안 읽은 알림 수"(/api/notifications/count)
  // 대신 "내가 승인 가능한 pending 게이트 수"(/api/gates?status=pending&assigned_to_me=true)로.
  // mobile-tab-bar.tsx가 이미 같은 계약으로 쓰던 것(story #1974 개인화·#1960 held fix 반영,
  // origin/main과 diff 0으로 prod에도 이미 있음, #1981 그라운딩 확認)을 그대로 재사용 — 새
  // 집계 발명 없음.
  const [inboxPendingCount, setInboxPendingCount] = useState(0);
  // story #1977(트랙B) GNB ③ 채팅 unread 총합 — story #2007로 dashboard-shell.tsx의 단일
  // useChatUnreadTotal() 호출 결과를 prop으로 받는다(MobileTabBar와 SSE 연결 중복 제거).
  // story #4413 — 팔레트 열림 상태는 셸 층 한 벌(사이드바 단추 · ⌘K · 폰 «전체» 검색 행이 같은 상태).
  const { open: paletteOpen, setOpen: setPaletteOpen } = useCommandPalette();

  // story 5031 — the zones and their fold memory are gone from this column: drop the value an earlier version left in this browser (a failed removal changes nothing).
  useEffect(() => {
    try {
      window.localStorage.removeItem('sidebar_group_collapsed');
    } catch {
      /* private window / blocked storage — nothing to clean */
    }
  }, []);

  // story 5032 (PO 11-27): the ⌘K binding moved out of this component into the shell (hooks/use-command-palette-shortcut — mounted by dashboard-shell) so taking this column out of the shell cannot take ⌘K with it

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mux = useSseMultiplexerContext();

  useEffect(() => {
    let cancelled = false;
    const fetchPending = async () => {
      try {
        // story #2160 — 30초 폴링이 401을 조용히 삼키던 자리(fetchWithAuth로 전환) — 그
        // 규율은 story #1981의 새 엔드포인트에도 그대로 적용한다.
        // story #3084(2026-08-25 층1, PO 확定) — assigned_to_me(project access+not-author,
        // "누가 승인 자격이 있나"의 넓은 질문)를 designated-pending-count(순수 "내가 지정
        // 결재자로 지정된 미해소 건이 몇 개인가", room 추론 0)로 교체. #3001부터 카드가
        // 지정 라인 전용으로만 발행되므로 이 좁은 쿼리가 GNB "미확認" 뱃지의 정확한 SSOT다
        // (BE 문서 gates.py::get_designated_pending_count — "AC1이 이 층에서 닫히는 근거").
        // story #4171 — 진행 중 요청 공유(모바일 첫 화면 중복 1건 제거 — 폰 탭바는 story #4885부터 이 수를 따로 안 센다).
        const count = await fetchDesignatedPendingCount();
        if (count !== null && !cancelled) setInboxPendingCount(count);
      } catch { /* noop */ }
    };

    void fetchPending();
    intervalRef.current = setInterval(() => { void fetchPending(); }, 30000);

    const handleVisibility = () => {
      if (!document.hidden) void fetchPending();
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      cancelled = true;
      if (intervalRef.current) clearInterval(intervalRef.current);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, []);

  // story #3084(2026-08-25 층1) — "라이브 카운트"(유나 규격 §3). 승인/토스/위임 어느 쪽이든
  // 이 뱃지가 세는 집합(designated_approver_id=me AND status=pending)을 바꿀 수 있는
  // 이벤트 전부(story #4885부터 «새로 생김» conversation.gate_created 포함 — DESIGNATED_PENDING_COUNT_EVENTS)에서 즉시 재조회(30초 폴링은 mux 미연결/이벤트 유실 대비 안전망으로 유지).
  // story #4245 — 연결 직후 백필 중 **마지막 수에 이미 보였던** 이벤트는 다시 묻지 않는다(dev 배포 21 · 기동마다 designated-pending-count
  // 2번째 요청의 발신 지점이 이 자리였다). story #4263 — 그 구독 · 판정을 한 곳(subscribeDesignatedPendingCount)으로.
  // 실패는 null — 다음 정상 이벤트나 30초 폴링으로 자연 회복.
  useEffect(() => {
    if (!mux) return;
    return subscribeDesignatedPendingCount(mux, setInboxPendingCount);
  }, [mux]);

  return (
    <>
    {/* story #4885 B 셸 — 이 칸은 «목록» 칸이다: 왼쪽 끝은 아이콘 막대(nav-rail · w-14 = 3.5rem)가 쥐고, 이 칸은 그 오른쪽에 선다(접히면 막대 뒤로 들어감). */}
    <Sidebar
      variant="inset"
      collapsible="offcanvas"
      className="data-[side=left]:left-14 data-[side=left]:group-data-[collapsible=offcanvas]:left-[calc(3.5rem-var(--sidebar-width))]"
    >
      <SidebarHeader className="py-3">
        <UnifiedSwitcher
          orgs={orgMemberships}
          currentOrgId={orgId}
          projects={projectMemberships}
          currentProjectId={projectId}
          className="w-full"
        />
        {/* story 4713: inside the desktop app «+ 새 프로젝트» is one line right here, outside the switcher's menu (a browser: nothing) */}
        <NewProjectEntry className="mt-1 h-8 min-h-0 w-full justify-start gap-2 px-2.5 text-sm text-muted-foreground" />
        {/* story 4832: the door for this organization's agents → this computer, named by what it does (not behind «새 프로젝트») */}
        <MoveAgentsEntry className="h-8 min-h-0 w-full justify-start gap-2 px-2.5 text-sm text-muted-foreground" />
      </SidebarHeader>

      <SidebarContent className="scrollbar-visible">
        {/* story 5031 (C1 step 2a) — one group: the rows of the place you are in (nav-depth1 · listItemsForSlot). A row is the same NavRow as before (ds ListRow); the chat place also lists its chat row (CHAT_CENTER_ITEM) first. */}
        {/* the kit's list column: 256 wide, rows 240 (8 each side → the group takes no padding of its own) with 4 between rows (gap-1) */}
        <SidebarGroup className="p-0">
          <SidebarGroupContent>
            <SidebarMenu className="gap-1" data-testid="depth1-list" data-depth1-slot={activeSlot}>
              {slotItems.map((item) => {
                // «일감»(id 'board')의 1차 진입점은 resolveNavGroups가 정한 경로 그대로 resourceLink에 넘긴다 — 활성 판정만 WORKSPACE_FRAME_TAB_PATHS 전체(탭 어디서든 켜짐 · story #3844).
                const link = item.kind === 'static'
                  ? { href: flatHref(item.path), isActive: item.id === shownActiveStaticItemId }
                  : resourceLink(item.path, item.id === 'board' ? WORKSPACE_FRAME_TAB_PATHS : []);
                const Icon = item.icon;
                const badgeCount = item.badgeKey === 'inbox' ? inboxPendingCount : item.badgeKey === 'chats' ? chatUnreadTotal : 0;
                const badgeCap = item.badgeKey === 'inbox' ? 9 : 99;
                return (
                  <NavRow
                    key={item.id}
                    navId={item.id}
                    href={link.href}
                    label={t(item.labelKey)}
                    Icon={Icon}
                    isActive={link.isActive}
                    activeRef={link.isActive ? activeMenuItemRef : undefined}
                    kbd={item.kbdHint && isRealShortcut([item.kbdHint]) ? item.kbdHint : null}
                    badgeCount={item.badgeKey ? badgeCount : 0}
                    badgeCap={badgeCap}
                    badgeLabel={item.badgeKey === 'inbox' ? t('railNeedsHand') : undefined}
                  />
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarRail />
    </Sidebar>
    {/* story #4413 — 팔레트는 Sidebar 밖에 둔다: 폰에서 Sidebar는 시트라 닫혀 있으면 안쪽이 안 그려져 팔레트도 없었다. */}
    <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} projectId={projectId} contextStoryId={contextStoryId} />
    </>
  );
}
