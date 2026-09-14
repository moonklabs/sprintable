'use client';

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { Button } from '@/components/ui/button';
import { fetchWithAuth } from '@/lib/db/client';
import { cn } from '@/lib/utils';
import {
  NAV_GROUPS,
  CHAT_CENTER_ITEM,
  groupVisibleLegacyByTarget,
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

// story #d986fd6c(IA·S4)의 «활성 구역+뷰포트 높이로 기본 접힘을 역산» 규칙은 폐기된
// 전제다(선생님 決 2026-09-09 01:28Z 「그냥 디폴트를 다 펼쳐두고 접을 수 있게 하면
// 좋을 것 같다」 — story #f81657f8). nav-config.ts::computeActiveZoneCollapsedGroupIds
// 자체가 삭제됐고, 기본 접힘은 이제 뷰포트/활성 구역과 무관한 빈 Set(전부 펼침) —
// 컴포넌트 내부의 useMemo(defaultCollapsedGroupIds)가 그 상수를 그대로 반환한다.
//
// 사람별 기억(AC3) — 그룹 id별 접힘 여부 수동 오버라이드. localStorage(계정 단위가 아니라
// 이 브라우저 단위이지만, "사람별로 기억된다"는 AC 문면은 "같은 사람이 다시 왔을 때
// 유지"를 요구할 뿐 서버 동기화까지 요구하지 않는다 — sidebar_width와 같은 관례). 값이
// 없는 그룹은 위 동적 기본값을 따른다(AC3 "기억이 없을 때도 기본값으로 온전히 선다").
const SIDEBAR_GROUP_COLLAPSED_STORAGE_KEY = 'sidebar_group_collapsed';

// story #3836(UX-v3·셸 후속, 선생님 지적 2026-09-14) — NAV_GROUPS 밖의 새 접힘 절(「더보기」,
// LEGACY_NAV_ITEMS 17개). id는 모바일 /more의 legacyGroup.id('legacy')와 맞춰(같은 개념,
// 두 화면에서 같은 이름) collapsedOverrides가 이 그룹도 NAV_GROUPS와 동일한 «사람별 기억»
// 경로를 그대로 탄다(아래 mergeStoredCollapsedOverrides가 group id 목록을 인자로 받도록
// 넓혀 NAV_GROUPS 밖 이 id도 포함시킨다 — 전용 코드 경로 0).
const LEGACY_GROUP_ID = 'legacy';

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
  collapsibleGroupIds: string[],
): Set<string> {
  const next = new Set(defaults);
  for (const groupId of collapsibleGroupIds) {
    const stored = overrides[groupId];
    if (stored === undefined) continue;
    if (stored) next.add(groupId);
    else next.delete(groupId);
  }
  return next;
}

function KbdHint({ children }: { children: React.ReactNode }) {
  return (
    // 3826-pre — text-sidebar-foreground/60(알파 합성)이 v3 ink 재조정 후 실 브라우저
    // 대비 미달(#767573/#fbfaf9 = 4.43:1)로 바뀌었다. solid text-muted-foreground(=
    // --proof-ink-3, AA 조정 済)로 교체 — active 상태는 알파 대신 solid 전체 강조.
    <kbd className="hidden rounded border border-sidebar-border/60 bg-sidebar-accent/40 px-1.5 py-0 font-mono text-[10px] font-medium text-muted-foreground group-data-[active=true]/menu-button:text-sidebar-foreground sm:inline-flex">
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
// ⛔️무표식 = 조직 범위가 아니다(유나 § 명시) — org 11항목 + 애매 4항목(inbox·settings·
// org-briefing·org-workforce, 카디르 QA 재감사로 2→4 정정) 둘 다 무표식이다. 이 표식은
// "project임을 말한다"만 하지 "무표식=org"를 말하지 않는다.
function ScopeMark({ children }: { children: React.ReactNode }) {
  return (
    // 3826-pre — KbdHint와 동일 사유(알파 합성 → solid muted 교체).
    <span className="text-[10px] font-medium text-muted-foreground group-data-[active=true]/menu-button:text-sidebar-foreground">
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
  // story #d986fd6c(IA·S4) — 정적 항목 active 판정. 원래 렌더 루프 바로 앞(구 위치)에
  // 있었으나, 활성 구역 계산(아래)이 접힘 state보다 먼저 알아야 해 이 자리로 옮겼다 —
  // pathname/href만의 순수 함수라 위치 이동에 따른 의미 변화 없음.
  function isActive(href: string) {
    return pathname === href || (href !== '/' && pathname.startsWith(href));
  }
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
  const [paletteOpen, setPaletteOpen] = useState(false);

  const openPalette = useCallback(() => setPaletteOpen(true), []);

  // story #f81657f8(IA·S4 후속, 선생님 決 2026-09-09 01:28Z 「그냥 디폴트를 다 펼쳐두고
  // 접을 수 있게 하면 좋을 것 같다」) — 예전엔 여기서 현재 라우트의 활성 구역+뷰포트 높이를
  // 훑어 기본 접힘 집합을 역산했다(story #d986fd6c). 그 규칙 자체가 폐기됐으니 그 입력을
  // 만들던 계산(activeGroupId·viewportHeight)도 이제 이 자리에선 쓸모가 없다 — 기본값은
  // 뷰포트/활성 구역과 무관한 빈 Set(전부 펼침). 아래 collapsedOverrides(사람별 기억)가
  // 유일한 접힘 경로다.
  // story #3836 — 위 f81657f8 규칙(NAV_GROUPS는 기본 전부 펼침)은 그대로 두되, 「더보기」
  // (LEGACY_GROUP_ID)만 이 카드의 명시 AC1대로 기본 접힘이다 — 서로 다른 두 그룹 «종류»의
  // 기본값이 다른 것이지 f81657f8 결정을 뒤집는 게 아니다(그 결정은 NAV_GROUPS 대상으로
  // 그대로 유효).
  const defaultCollapsedGroupIds = useMemo(() => new Set<string>([LEGACY_GROUP_ID]), []);

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
  //
  // story #f81657f8 후속(페드루 PO 지적 2026-09-09) — 이 effect는 원래부터 이 형태였는데
  // disable 없이도 lint가 초록이었다(컴포넌트가 activeGroupId/viewportHeight 등 hook이
  // 많아 react-hooks 정적분석이 이 지점까지 못 들어가고 bail-out했던 것으로 보임). 이번
  // PR이 그 두 hook을 제거해 컴포넌트를 단순화하면서 분석이 실제로 이 자리까지 도달해
  // 가려져 있던 위반이 드러났다 — 지워 보고 lint를 돌려 재확인(그대로 걸림). 정당성은
  // 위 문단 그대로: localStorage 마운트-후 1회 하이드레이션(구독 없는 단발 읽기), 파생값은
  // 이미 useMemo로 분리.
  const [collapsedOverrides, setCollapsedOverrides] = useState<Record<string, boolean>>({});
  useEffect(() => {
    const overrides = readStoredCollapsedOverrides();
    if (Object.keys(overrides).length > 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 위 정당성 참고(localStorage 1회 하이드레이션)
      setCollapsedOverrides(overrides);
    }
  }, []);
  const collapsibleGroupIds = useMemo(
    () => [...NAV_GROUPS.map((g) => g.id), LEGACY_GROUP_ID],
    [],
  );
  const collapsedGroupIds = useMemo(
    () => mergeStoredCollapsedOverrides(defaultCollapsedGroupIds, collapsedOverrides, collapsibleGroupIds),
    [defaultCollapsedGroupIds, collapsedOverrides, collapsibleGroupIds],
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

  // story #2930(P0-G) I2, doc ia-4zone-redesign-2930 — 챗 「center(중심 꽃)」. 4구역
  // «밖» 1급으로 승격(선생님 확定) — NAV_GROUPS 순회에 안 실린다(구역에 묻으면 강등이라는
  // 게 이 승격의 요점). 시안 아티팩트(6242dffb .chatc) 그대로: 상시 blue-soft 카드,
  // active/inactive로 톤이 안 바뀐다(항상 눈에 띄어야 하는 1급 자리라 일반 nav 항목의
  // "현재 페이지만 강조" 관례를 안 따름 — 시안에도 active 변형이 없다).
  // story #3824 CHANGES①(페드루 PO 確定, 2026-09-13 09:01Z) — 정본 순서는 오늘→대화→
  // 일감→결과→연결·규칙(「오늘」=첫 화면). NAV_GROUPS는 계속 "구역 밖 1급"이라 순회
  // 대상은 아니지만(승격 자체는 무변경), 렌더 위치만 옮겨 NAV_GROUPS[0](오늘) 바로
  // 뒤·NAV_GROUPS[1](일감) 앞에 서게 한다 — 이 변수를 아래 SidebarContent map 안,
  // 첫 그룹 뒤에 삽입한다.
  const chatCenterCard = (
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
  );

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
        {/* 3826-pre — text-sidebar-foreground/60(알파 합성) → solid text-muted-foreground.
            v3 ink 재조정 후 실 대비 미달 실측(#767573/#fbfaf9=4.43:1·⌘K kbd
            #747371/#f7f6f3=4.37:1). */}
        <button
          type="button"
          onClick={openPalette}
          className="mt-2 flex w-full items-center gap-2 rounded-md border border-sidebar-border/60 bg-sidebar-accent/30 px-2.5 py-1.5 text-left text-sm text-muted-foreground transition hover:border-sidebar-border hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
          aria-label={t('search')}
        >
          <Search className="size-4" />
          <span className="flex-1 truncate">{t('search')}</span>
          <kbd className="hidden rounded border border-sidebar-border/60 bg-sidebar-accent/40 px-1.5 py-0 font-mono text-[10px] font-medium text-muted-foreground sm:inline-flex">
            ⌘K
          </kbd>
        </button>
      </SidebarHeader>

      <SidebarContent className="scrollbar-visible">
        {/* story #2681 — 데스크톱 GNB와 모바일 /more 허브(S2)가 한 정의(NAV_GROUPS)에서
            파생된다(doc mobile-ia-full-completion-2678 §2.5-3). 그룹·항목 목록 자체는
            nav-config.ts가 유일한 출처이고, 여기선 오직 순회+렌더만 한다 — 순서·라벨·아이콘·
            그룹핑은 이 리팩터 전과 동일(시각 회귀 0, AC1). story #2930 I1 — 이제 4구역+관리
            프레임 순서(오늘→워크스페이스→신뢰→지식→조직→설정)로 재편됐다. chats는 위
            챗 center로 승격돼 이 순회 밖이라 badgeKey는 이제 'inbox' 하나만 실질 도달한다.
            story #3762 — 4구역+관리 프레임 전체 높이가 흔한 뷰포트(≤900px)를 넘어서며
            전역 스크롤바 숨김(#2165)까지 겹쳐 신뢰 아래 구역이 스크롤 가능한데도 "없다"로
            보였다(그라운딩: org/role 무관 재현 — CSS overflow affordance 결함, 컨텍스트
            문제 아님). .scrollbar-visible은 story #2528과 동일한 기존 옵트인 패턴. */}
        {NAV_GROUPS.map((group, groupIndex) => {
          // story #d986fd6c(IA·S4) — 라벨 없는 유틸 그룹(설정)은 접기 대상이 아니다(항목
          // 1개뿐이라 접어 봤자 얻는 게 없고, ia-4zone 확定이 이미 "라벨 없는 유틸 그룹"
          // 으로 못박아 뒀다 — 헤더 자체가 없으니 토글할 자리도 없다).
          const isCollapsible = Boolean(group.labelKey);
          const isCollapsed = isCollapsible && collapsedGroupIds.has(group.id);
          const groupLabel = group.labelKey ? t(group.labelKey) : '';
          // 카디르 QA(a11y, §22-18 가드) — render prop이 넘기는 버튼 요소는 SidebarGroupLabel의
          // children(그룹명 텍스트+쉐브론 아이콘)을 감싸기만 할 뿐 버튼 자체에 접근가능한
          // 이름이 안 실린다(스크린리더가 7구역 토글을 구별 못 함) — aria-label에 그룹명+
          // 접힘상태를 명시로 채워 넣는다.
          const toggleAriaLabel = isCollapsed
            ? t('groupExpand', { group: groupLabel })
            : t('groupCollapse', { group: groupLabel });
          return (
          <Fragment key={group.id}>
          <SidebarGroup>
            {group.labelKey ? (
              <SidebarGroupLabel
                render={
                  <button
                    type="button"
                    onClick={() => toggleGroupCollapsed(group.id)}
                    aria-expanded={!isCollapsed}
                    aria-label={toggleAriaLabel}
                  />
                }
                className="w-full cursor-pointer justify-between hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              >
                <span>{groupLabel}</span>
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
                        render={<Link href={link.href} ref={link.isActive ? activeMenuItemRef : undefined} />}
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
          {/* story #3824 CHANGES①(페드루 PO 確定) — 「대화」 챗 center를 「오늘」(항상
              groupIndex 0) 바로 뒤·「일감」 앞에 삽입. 구역 밖 1급 승격 자체는 무변경 —
              렌더 «위치»만 옮긴다. */}
          {groupIndex === 0 ? chatCenterCard : null}
          </Fragment>
          );
        })}
        {/* story #3836(UX-v3·셸 후속, 선생님 지적 2026-09-14) — 3824가 5항목으로 줄이며
            사이드바에서 빠진 LEGACY_NAV_ITEMS 17개(⌘K 팔레트·모바일 /more가 이미 그 1급
            진입점)를 이 접힘 절로 되돌린다. 항목 자체는 VISIBLE_LEGACY_NAV_ITEMS(nav-
            config.ts SSOT, 모바일 /more와 정확히 같은 정의) 그대로 순회 — 이 파일이
            자기만의 목록을 다시 짓지 않는다(AC2/AC3). 기본 접힘(AC1) — 위 f81657f8은
            NAV_GROUPS(전부 펼침)만의 결정이라 이 새 그룹엔 안 걸린다. */}
        {(() => {
          // story #3855(customer-zero·셸) — 「더보기」 안 항목을 §② 흡수 지도 머리말별로
          // 묶는다(groupVisibleLegacyByTarget, nav-config.ts SSOT — more/page.tsx와 같은
          // 함수 재사용). 링크 계산 자체는 3836과 동일(static/resource 링크, 새 축 0) —
          // 그룹마다 반복하지 않고 전 항목을 한 번에 링크로 만든 뒤 그룹별로 다시 읽는다.
          const legacyGroups = groupVisibleLegacyByTarget();
          const legacyLinkByItemId = new Map(
            legacyGroups.flatMap((group) => group.items).map((item) => [
              item.id,
              item.kind === 'static' ? { href: item.path, isActive: isActive(item.path) } : resourceLink(item.path),
            ]),
          );
          const legacyHasActiveItem = [...legacyLinkByItemId.values()].some((link) => link.isActive);
          const legacyIsCollapsed = collapsedGroupIds.has(LEGACY_GROUP_ID) && !legacyHasActiveItem;
          const legacyGroupLabel = t('navMore');
          const legacyToggleAriaLabel = legacyIsCollapsed
            ? t('groupExpand', { group: legacyGroupLabel })
            : t('groupCollapse', { group: legacyGroupLabel });
          return (
            <SidebarGroup>
              <SidebarGroupLabel
                render={
                  // story #3164(DS 게이트 키스톤) 가드 — raw-button-baseline.json이 이
                  // 파일에 고정한 2건(기존 NAV_GROUPS 토글·⌘K 검색)은 grandfather라
                  // 그대로 두지만, 이 신규 토글은 소문자 버튼 태그를 새로 추가하는
                  // 자리라 baseline 초과로 걸린다(2026-09-14 CI 실측 — verify-no-new-
                  // raw-button.ts는 소스 텍스트를 문자 그대로 스캔해 주석 속 예시
                  // 표기까지 태그로 오인하므로 이 코멘트에도 그 표기를 쓰지 않는다).
                  // 캐노니컬 Button(@/components/ui/button)으로 — variant="ghost"의
                  // 부가 스타일(aria-expanded 틴트·citron 포커스 링)은 아래 className
                  // 에서 명시로 되돌려 기존 그룹 토글과 시각 동일(실 브라우저 재캡처로
                  // 확認, AC5 캡처 2 갱신).
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => toggleGroupCollapsed(LEGACY_GROUP_ID)}
                    aria-expanded={!legacyIsCollapsed}
                    aria-label={legacyToggleAriaLabel}
                  />
                }
                // 유나 QA 코드리뷰 지적(2026-09-14, 페드루 전달) — mergeProps(Base UI, 일반
                // React prop 병합)는 이 저장소 cn()의 tailwind-merge와 다른 함수라 Button
                // size="default"의 `min-h-11`(44px)이 `h-8`(32px, min-height가 아닌 height라
                // twMerge 충돌군이 애초에 다름)과 절대 충돌하지 않고 살아남는다 — min-height가
                // 선언된 height보다 크면 렌더 높이는 min-height를 따른다(CSS 규격). `min-h-8`
                // 명시로 그 최소치를 형제 라벨과 맞춘다(min-w-11도 동형 이유로 함께 되돌림).
                className="w-full min-h-8 min-w-0 cursor-pointer justify-between rounded-md border-0 bg-transparent aria-expanded:bg-transparent hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:border-transparent"
              >
                <span>{legacyGroupLabel}</span>
                <ChevronDown className={cn('size-3.5 shrink-0 transition-transform duration-150', legacyIsCollapsed && '-rotate-90')} />
              </SidebarGroupLabel>
              {!legacyIsCollapsed ? (
                <SidebarGroupContent>
                  {/* story #3855 AC2 — 캡션 1줄(§⑤ 해요체·「이사 안내판」 취지). 링크·머리말
                      둘 다 아닌 순수 안내문이라 SidebarMenu 밖, 첫 그룹 위에 한 번만. */}
                  <p className="px-[9px] pt-px pb-1 text-[11.5px] text-muted-foreground" data-testid="legacy-moving-caption">
                    {t('moreLegacyMovingCaption')}
                  </p>
                  {legacyGroups.map((group, groupIndex) => (
                    <div key={group.target} className="space-y-0.5" data-legacy-group={group.target}>
                      {/* 픽셀 커밋(페드루 PO 판정 2026-09-14 07:34Z, 유나 시안 77731332
                          getComputedStyle 대조) — 묶음 사이 구분선(border 토큰) 1px·margin
                          5px 8px 4px, 첫 그룹 앞엔 없음. */}
                      {groupIndex > 0 ? <div className="mx-2 mt-[5px] mb-1 h-px bg-border" /> : null}
                      {/* AC2 — 머리말은 링크·버튼이 아니다(순수 텍스트, 클릭 불가). 시안이
                          지정한 안내 문구(머리말 옆 회색 note, 예: 「만드는 곳(일)…」)는 PO가
                          §⑤ 내부 낱말·사이드바 폭 이유로 명시 제외했다 — 이름+개수 pill만. */}
                      <p className="flex items-baseline gap-1.5 px-2 pt-0.5 pb-px text-[11px] font-bold tracking-[.03em] text-muted-foreground">
                        <span>{t(group.labelKey)}</span>
                        <span className="rounded-full bg-muted px-1.5 text-[10px] font-bold leading-[15px] text-muted-foreground">
                          {group.items.length}
                        </span>
                      </p>
                      <SidebarMenu>
                        {group.items.map((item) => {
                          const link = legacyLinkByItemId.get(item.id)!;
                          const Icon = item.icon;
                          const label = t(item.labelKey);
                          return (
                            <SidebarMenuItem key={item.id}>
                              <SidebarMenuButton
                                render={
                                  <Link
                                    href={link.href}
                                    ref={link.isActive ? activeMenuItemRef : undefined}
                                    data-legacy-nav-id={item.id}
                                  />
                                }
                                isActive={link.isActive}
                                tooltip={label}
                              >
                                <Icon />
                                <span data-nav-label>{label}</span>
                                {item.scope === 'project' ? (
                                  <span className="ml-auto flex shrink-0 items-center gap-1.5">
                                    <ScopeMark>{t('scopeProject')}</ScopeMark>
                                  </span>
                                ) : null}
                              </SidebarMenuButton>
                            </SidebarMenuItem>
                          );
                        })}
                      </SidebarMenu>
                    </div>
                  ))}
                </SidebarGroupContent>
              ) : null}
            </SidebarGroup>
          );
        })()}
      </SidebarContent>

      <SidebarFooter className="space-y-2 p-2">
        {/* story #3775(유나 定 2026-09-10) — 이름 없는(OAuth 신규 가입) 사용자는 이전엔
            이 칩 자체가 안 그려져 설정으로 가는 경로 하나가 통째로 막혀 있었다(결함,
            유도 장치가 아니다). 이름 유무와 무관하게 항상 그린다 — 이름 없을 때의
            표시(「이름 없는 구성원」)와 「이름 설정」 메뉴 항목은 ProfileMenu 내부에서
            처리(공용 memberDisplayLabel 재사용, story #3755/#3758과 같은 헬퍼). */}
        <ProfileMenu name={userName ?? null} />
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
