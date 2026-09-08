'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ChevronDown, Search, MessageSquare } from 'lucide-react';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { ThemeToggle } from '@/components/nav/theme-toggle';
import { CommandPalette } from '@/components/command-palette/command-palette';
import { ProfileMenu } from '@/components/nav/profile-menu';
import { BusinessInfoDisclosure } from '@/components/nav/business-info-disclosure';
import { UnifiedSwitcher, type OrgSwitcherItem } from '@/components/nav/unified-switcher';
import { fetchWithAuth } from '@/lib/db/client';
import { cn } from '@/lib/utils';
import {
  NAV_GROUPS,
  CHAT_CENTER_ITEM,
  computeDefaultCollapsedGroupIds,
  SIDEBAR_FIRST_SCREEN_ITEM_BUDGET,
} from '@/lib/nav-config';
import { useSseMultiplexerContext } from '@/components/realtime-provider';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar';

interface AppSidebarProps {
  orgId?: string;
  orgMemberships?: OrgSwitcherItem[];
  projectId?: string;
  // story a539c649 S2: 문서 바로가기가 /{ws}/{proj}/docs 직접 path 를 만드는 데만 쓴다 — 없으면
  // bare `/docs`로 폴백(미들웨어 리다이렉트 안전망이 받음).
  currentProjectSlug?: string;
  projectMemberships: Array<{ projectId: string; projectName: string }>;
  userName?: string;
  // story #2007(perf·서버부하): dashboard-shell.tsx가 단일 useChatUnreadTotal() 호출 결과를
  // prop으로 내려준다 — 여기서 직접 훅을 호출하면 MobileTabBar와 각자 SSE 연결을 열게 된다.
  chatUnreadTotal: number;
}

// story #d986fd6c(IA·S4, PO 確定 2026-09-08) — 기본 접힘 집합(규칙은 nav-config.ts::
// computeDefaultCollapsedGroupIds, 임계값은 SIDEBAR_FIRST_SCREEN_ITEM_BUDGET). 임계값이
// 아직 PENDING(null — 배포 54 뒤 실측)이라 지금은 빈 집합(전 구역 기본 펼침) — 임의로
// 특정 구역을 손으로 접어 두지 않는다(AC1 "임의 수 금지"의 정신). 임계값이 채워지는
// 순간 이 상수도 그 규칙을 그대로 따른다(코드 변경 0, 값만 채우면 됨).
const DEFAULT_COLLAPSED_GROUP_IDS: Set<string> = SIDEBAR_FIRST_SCREEN_ITEM_BUDGET != null
  ? computeDefaultCollapsedGroupIds(
      NAV_GROUPS.map((g) => ({ id: g.id, itemCount: g.items.length })),
      SIDEBAR_FIRST_SCREEN_ITEM_BUDGET,
    )
  : new Set<string>();

// 사람별 기억(AC3) — 그룹 id별 접힘 여부. localStorage(계정 단위가 아니라 이 브라우저 단위
// 이지만, "사람별로 기억된다"는 AC 문면은 "같은 사람이 다시 왔을 때 유지"를 요구할 뿐
// 서버 동기화까지 요구하지 않는다 — sidebar_width와 같은 관례). 값이 없는 그룹은
// DEFAULT_COLLAPSED_GROUP_IDS를 따른다(AC3 "기억이 없을 때도 기본값으로 온전히 선다").
const SIDEBAR_GROUP_COLLAPSED_STORAGE_KEY = 'sidebar_group_collapsed';

function readStoredCollapsedOverrides(): Record<string, boolean> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(SIDEBAR_GROUP_COLLAPSED_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function mergeStoredCollapsedOverrides(
  defaults: Set<string>,
  overrides: Record<string, boolean>,
): Set<string> {
  const next = new Set(defaults);
  for (const group of NAV_GROUPS) {
    const stored = overrides[group.id];
    if (stored === undefined) continue;
    if (stored) next.add(group.id);
    else next.delete(group.id);
  }
  return next;
}

function KbdHint({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="hidden rounded border border-sidebar-border/60 bg-sidebar-accent/40 px-1.5 py-0 font-mono text-[10px] font-medium text-sidebar-foreground/60 group-data-[active=true]/menu-button:text-sidebar-foreground/80 sm:inline-flex">
      {children}
    </kbd>
  );
}

// story #9c5e82dc(IA·S3, 유나 § 確定 2026-09-08) — 「이 항목은 프로젝트 것」이라는 «성질»
// 표식. 칩/배지 모양(테두리·배경) 금지 — 칩은 "누를 수 있는 것"으로 읽히는데 이건 행위가
// 아니라 성질이다. 라틴 약어("PJ")·아이콘 단독+sr-only 둘 다 기각(유나 § 그대로 — 약어는
// 배워야 하는 어휘, sr-only는 시각 사용자에게 아무 말도 안 함). kbd(#KbdHint)와 같은
// 자리·비슷한 크기(10px)지만 mono가 아니라 본문 폰트(한글이라). 순서는 라벨→표식→kbd
// (성질이 이름에 붙고 행위가 끝에 간다).
//
// ⛔️무표식 = 조직 범위가 아니다(유나 § 명시) — org 13항목 + 애매 2항목(inbox·settings)
// 둘 다 무표식이다. 이 표식은 "project임을 말한다"만 하지 "무표식=org"를 말하지 않는다.
function ScopeMark({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[10px] font-medium text-sidebar-foreground/60 group-data-[active=true]/menu-button:text-sidebar-foreground/80">
      {children}
    </span>
  );
}

export function AppSidebar({
  orgId,
  orgMemberships = [],
  projectId,
  currentProjectSlug,
  projectMemberships,
  userName,
  chatUnreadTotal,
}: AppSidebarProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // story a539c649(S2 최초·S3 리소스 확장) — 실 ws/proj slug 있으면 직접 path(리다이렉트 홉
  // 절약) — 없으면 bare `/{resource}`(미들웨어의 bare→쿠키 default 해소 301 안전망이 받는다).
  const orgSlug = orgMemberships.find((o) => o.orgId === orgId)?.orgSlug;
  function resourceLink(resource: string): { href: string; isActive: boolean } {
    const href = orgSlug && currentProjectSlug ? `/${orgSlug}/${currentProjectSlug}/${resource}` : `/${resource}`;
    const isActive = pathname === `/${resource}` || pathname.startsWith(`/${resource}/`)
      || Boolean(orgSlug && currentProjectSlug && pathname.startsWith(`/${orgSlug}/${currentProjectSlug}/${resource}`));
    return { href, isActive };
  }
  // story #2224(IA v2.2 §7-3, AC12) — 기본 진입은 /flow, 사이드바가 통합뷰를 가리킨다.
  // 칸반은 /flow?view=list로 흡수됐다(PR#2698, `/board` 라우트 자체는 삭제) — 사이드바에
  // board를 flow와 나란히 1Depth로 세우지 않는다("나란히 두면 「내렸다」가 무효가 된다" —
  // §7-3) — /flow 안의 보기 전환(?view=list)이 "내비 2Depth 이하" 요건을 충족하는 그 자리다.
  const flowLink = resourceLink('flow');
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

  // story #1981 — GNB 결재함 배지 semantic 교체: "안 읽은 알림 수"(/api/notifications/count)
  // 대신 "내가 승인 가능한 pending 게이트 수"(/api/gates?status=pending&assigned_to_me=true)로.
  // mobile-tab-bar.tsx가 이미 같은 계약으로 쓰던 것(story #1974 개인화·#1960 held fix 반영,
  // origin/main과 diff 0으로 prod에도 이미 있음, #1981 그라운딩 확認)을 그대로 재사용 — 새
  // 집계 발명 없음.
  const [inboxPendingCount, setInboxPendingCount] = useState(0);
  // story #1977(트랙B) GNB ③ 채팅 unread 총합 — story #2007로 dashboard-shell.tsx의 단일
  // useChatUnreadTotal() 호출 결과를 prop으로 받는다(MobileTabBar와 SSE 연결 중복 제거).
  const [paletteOpen, setPaletteOpen] = useState(false);

  const openPalette = useCallback(() => setPaletteOpen(true), []);

  // story #d986fd6c(IA·S4) — 그룹별 접힘 «기억». 서버 렌더는 항상 빈 overrides({})로
  // 시작해(하이드레이션 불일치 방지, sidebar_width의 SIDEBAR_WIDTH_STORAGE_KEY 마운트-후
  // 읽기와 동형 패턴 — ui/sidebar.tsx:81-83) 마운트 후 이 effect가 localStorage 원문을
  // 그대로 얹는다. localStorage는 React 밖 외부 저장소라 마운트 시점 1회 동기화는 정확히
  // 이 effect가 있어야 하는 자리(구독 없는 단발성 읽기 — storage 이벤트는 다른 탭 변경만
  // 알리고 같은 탭 내 최초 하이드레이션은 못 잡는다).
  // sidebar_width와 같은 목적(SSR-세이프 localStorage 하이드레이션)이나 그쪽은 원시값
  // 단일 setState라 react-hooks/set-state-in-effect에 안 걸리고, 이쪽은 객체라 걸린다 —
  // 파생값(Set)은 이미 위 useMemo로 분리해 뒀으니 이 setState 자체는 "외부 저장소를
  // 그대로 얹는" 정당한 동기화다.
  const [collapsedOverrides, setCollapsedOverrides] = useState<Record<string, boolean>>({});
  useEffect(() => {
    const overrides = readStoredCollapsedOverrides();
    if (Object.keys(overrides).length > 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCollapsedOverrides(overrides);
    }
  }, []);
  const collapsedGroupIds = useMemo(
    () => mergeStoredCollapsedOverrides(DEFAULT_COLLAPSED_GROUP_IDS, collapsedOverrides),
    [collapsedOverrides],
  );

  const toggleGroupCollapsed = useCallback((groupId: string) => {
    setCollapsedOverrides((prev) => {
      const wasCollapsed = collapsedGroupIds.has(groupId);
      const next = { ...prev, [groupId]: !wasCollapsed };
      try {
        window.localStorage.setItem(SIDEBAR_GROUP_COLLAPSED_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // story #d986fd6c — localStorage 실패(프라이빗 창·용량 등)는 이 세션 안 상태만
        // 유지하고 조용히 넘어간다(기억 실패가 사이드바 자체를 못 쓰게 만들면 안 된다).
      }
      return next;
    });
  }, [collapsedGroupIds]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const isMod = event.metaKey || event.ctrlKey;
      if (!isMod || event.key.toLowerCase() !== 'k') return;
      const target = event.target as HTMLElement | null;
      if (target?.isContentEditable) return;
      event.preventDefault();
      setPaletteOpen((prev) => !prev);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

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
        const res = await fetchWithAuth('/api/gates/designated-pending-count');
        if (!res.ok || cancelled) return;
        const json = await res.json() as { count?: number };
        if (!cancelled) {
          setInboxPendingCount(typeof json.count === 'number' ? json.count : 0);
        }
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
  // 이 뱃지가 세는 집합(designated_approver_id=me AND status=pending)을 바꿀 수 있는 3
  // 이벤트 전부에서 즉시 재조회(30초 폴링은 mux 미연결/이벤트 유실 대비 안전망으로 유지).
  useEffect(() => {
    if (!mux) return;
    const refetch = () => {
      void fetchWithAuth('/api/gates/designated-pending-count')
        .then((r) => (r.ok ? r.json() : null))
        .then((json: { count?: number } | null) => {
          if (json && typeof json.count === 'number') setInboxPendingCount(json.count);
        })
        .catch(() => { /* noop — 다음 정상 이벤트나 30초 폴링으로 자연 회복 */ });
    };
    const unsubs = [
      mux.subscribe('conversation.gate_resolved', refetch),
      mux.subscribe('conversation.gate_delegated', refetch),
      mux.subscribe('conversation.gate_tossed', refetch),
    ];
    return () => { for (const unsub of unsubs) unsub(); };
  }, [mux]);

  function isActive(href: string) {
    return pathname === href || (href !== '/' && pathname.startsWith(href));
  }

  return (
    <Sidebar variant="inset" collapsible="offcanvas">
      <SidebarHeader className="py-3">
        <UnifiedSwitcher
          orgs={orgMemberships}
          currentOrgId={orgId}
          projects={projectMemberships}
          currentProjectId={projectId}
          className="w-full"
        />
        <button
          type="button"
          onClick={openPalette}
          className="mt-2 flex w-full items-center gap-2 rounded-md border border-sidebar-border/60 bg-sidebar-accent/30 px-2.5 py-1.5 text-left text-sm text-sidebar-foreground/60 transition hover:border-sidebar-border hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
          aria-label={t('search')}
        >
          <Search className="size-4" />
          <span className="flex-1 truncate">{t('search')}</span>
          <kbd className="hidden rounded border border-sidebar-border/60 bg-sidebar-accent/40 px-1.5 py-0 font-mono text-[10px] font-medium text-sidebar-foreground/60 sm:inline-flex">
            ⌘K
          </kbd>
        </button>
      </SidebarHeader>

      {/* story #2930(P0-G) I2, doc ia-4zone-redesign-2930 — 챗 「center(중심 꽃)」. 4구역
          «밖» 1급으로 승격(선생님 확定) — NAV_GROUPS 순회에 안 실린다(구역에 묻으면 강등이라는
          게 이 승격의 요점). 시안 아티팩트(6242dffb .chatc) 그대로: 상시 blue-soft 카드,
          active/inactive로 톤이 안 바뀐다(항상 눈에 띄어야 하는 1급 자리라 일반 nav 항목의
          "현재 페이지만 강조" 관례를 안 따름 — 시안에도 active 변형이 없다). */}
      <div className="mx-2.5 mt-2">
        <Link
          href={CHAT_CENTER_ITEM.path}
          // story #3054(2984-S6) — GATE_BUTTON_TONE.primary(proof-capsule.tsx)와 동형으로
          // 헤어라인+elev 채택, bg-proof-blue-soft 채움 폐지. hover는 이제 solid 전환 대신
          // bg-sidebar-accent(기존 다른 nav 항목의 hover 관례와 정합) — AA 대비 이슈였던
          // hover:text-white/sidebar-primary-foreground 분기 자체가 불필요해졌다.
          className="flex items-center gap-2 rounded-[9px] border border-proof-blue bg-transparent px-2.5 py-2 text-proof-blue shadow-[var(--elev-card)] transition hover:bg-sidebar-accent"
        >
          <MessageSquare className="size-[18px] shrink-0" />
          <span className="flex-1 truncate text-[13px] font-bold">{t(CHAT_CENTER_ITEM.labelKey)}</span>
          {/* text-white 대신 sidebar-primary-foreground(다크에서 근흑색 — 수동 대비 확認,
              4.61 라이트·4.81 다크는 카드 톤이고 이 자리는 solid pill이라 별도 확認 필요했다:
              bg-proof-blue+text-white는 다크에서 3.21로 AA 미달. sidebar-primary-foreground는
              sidebar-primary(=proof-blue)와 짝으로 설계된 토큰이라 이 자리에 맞다). */}
          {chatUnreadTotal > 0 ? (
            <span className="shrink-0 rounded-full bg-sidebar-primary px-1.5 py-0.5 text-[9px] font-bold text-sidebar-primary-foreground">
              {chatUnreadTotal > 99 ? '99+' : chatUnreadTotal}
            </span>
          ) : null}
        </Link>
      </div>

      <SidebarContent>
        {/* story #2681 — 데스크톱 GNB와 모바일 /more 허브(S2)가 한 정의(NAV_GROUPS)에서
            파생된다(doc mobile-ia-full-completion-2678 §2.5-3). 그룹·항목 목록 자체는
            nav-config.ts가 유일한 출처이고, 여기선 오직 순회+렌더만 한다 — 순서·라벨·아이콘·
            그룹핑은 이 리팩터 전과 동일(시각 회귀 0, AC1). story #2930 I1 — 이제 4구역+관리
            프레임 순서(오늘→워크스페이스→신뢰→지식→조직→설정)로 재편됐다. chats는 위
            챗 center로 승격돼 이 순회 밖이라 badgeKey는 이제 'inbox' 하나만 실질 도달한다. */}
        {NAV_GROUPS.map((group) => {
          // story #d986fd6c(IA·S4) — 라벨 없는 유틸 그룹(설정)은 접기 대상이 아니다(항목
          // 1개뿐이라 접어 봤자 얻는 게 없고, ia-4zone 확定이 이미 "라벨 없는 유틸 그룹"
          // 으로 못박아 뒀다 — 헤더 자체가 없으니 토글할 자리도 없다).
          const isCollapsible = Boolean(group.labelKey);
          const isCollapsed = isCollapsible && collapsedGroupIds.has(group.id);
          return (
          <SidebarGroup key={group.id}>
            {group.labelKey ? (
              <SidebarGroupLabel
                render={
                  <button
                    type="button"
                    onClick={() => toggleGroupCollapsed(group.id)}
                    aria-expanded={!isCollapsed}
                  />
                }
                className="w-full cursor-pointer justify-between hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              >
                <span>{t(group.labelKey)}</span>
                <ChevronDown className={cn('size-3.5 shrink-0 transition-transform duration-150', isCollapsed && '-rotate-90')} />
              </SidebarGroupLabel>
            ) : null}
            {!isCollapsed ? (
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => {
                  const link = item.kind === 'static'
                    ? { href: item.path, isActive: isActive(item.path) }
                    : resourceLink(item.path);
                  const Icon = item.icon;
                  const badgeCount = item.badgeKey === 'inbox' ? inboxPendingCount : 0;
                  const badgeCap = item.badgeKey === 'inbox' ? 9 : 99;
                  const label = t(item.labelKey);
                  return (
                    <SidebarMenuItem key={item.id}>
                      <SidebarMenuButton
                        render={<Link href={link.href} />}
                        isActive={link.isActive}
                        tooltip={label}
                      >
                        <Icon />
                        <span data-nav-label>{label}</span>
                        {item.scope === 'project' || item.kbdHint ? (
                          <span className="ml-auto flex shrink-0 items-center gap-1.5">
                            {item.scope === 'project' ? <ScopeMark>{t('scopeProject')}</ScopeMark> : null}
                            {item.kbdHint ? <KbdHint>{item.kbdHint}</KbdHint> : null}
                          </span>
                        ) : null}
                        {item.badgeKey && badgeCount > 0 ? (
                          <SidebarMenuBadge>
                            {badgeCount > badgeCap ? `${badgeCap}+` : badgeCount}
                          </SidebarMenuBadge>
                        ) : null}
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
            ) : null}
          </SidebarGroup>
          );
        })}
      </SidebarContent>

      <SidebarFooter className="space-y-2 p-2">
        {userName && <ProfileMenu name={userName} />}
        <div className="flex items-center gap-1">
          <LocaleSwitcher />
          <ThemeToggle />
        </div>
        <BusinessInfoDisclosure />
      </SidebarFooter>

      <SidebarRail />
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} projectId={projectId} contextStoryId={contextStoryId} />
    </Sidebar>
  );
}
