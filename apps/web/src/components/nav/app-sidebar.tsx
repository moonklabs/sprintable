'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { CircleHelp, Search } from 'lucide-react';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { ThemeToggle } from '@/components/nav/theme-toggle';
import { CommandPalette } from '@/components/command-palette/command-palette';
import { ProfileMenu } from '@/components/nav/profile-menu';
import { UnifiedSwitcher, type OrgSwitcherItem } from '@/components/nav/unified-switcher';
import { fetchWithAuth } from '@/lib/db/client';
import { NAV_GROUPS } from '@/lib/nav-config';
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

function KbdHint({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="ml-auto hidden rounded border border-sidebar-border/60 bg-sidebar-accent/40 px-1.5 py-0 font-mono text-[10px] font-medium text-sidebar-foreground/60 group-data-[active=true]/menu-button:text-sidebar-foreground/80 sm:inline-flex">
      {children}
    </kbd>
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
  // story #2681 — docsLink는 footer 도움말 링크가 루프 밖에서 따로 참조해 개별 바인딩을
  // 유지한다(그 외 리소스 항목은 전부 NAV_GROUPS 순회 중 resourceLink()를 그 자리에서 호출).
  const docsLink = resourceLink('docs');
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

  const [inboxUnreadCount, setInboxUnreadCount] = useState(0);
  // story #1977(트랙B) GNB ③ 채팅 unread 총합 — story #2007로 dashboard-shell.tsx의 단일
  // useChatUnreadTotal() 호출 결과를 prop으로 받는다(MobileTabBar와 SSE 연결 중복 제거).
  const [paletteOpen, setPaletteOpen] = useState(false);

  const openPalette = useCallback(() => setPaletteOpen(true), []);

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

  useEffect(() => {
    let cancelled = false;
    const fetchUnread = async () => {
      try {
        // story #2160 — 30초 폴링이 401을 조용히 삼키던 자리(fetchWithAuth로 전환).
        const res = await fetchWithAuth('/api/notifications/count');
        if (!res.ok || cancelled) return;
        const json = await res.json() as { data?: { memoUnreadCount?: number; inboxUnreadCount?: number } };
        if (!cancelled) {
          setInboxUnreadCount(json.data?.inboxUnreadCount ?? 0);
        }
      } catch { /* noop */ }
    };

    void fetchUnread();
    intervalRef.current = setInterval(() => { void fetchUnread(); }, 30000);

    const handleVisibility = () => {
      if (!document.hidden) void fetchUnread();
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      cancelled = true;
      if (intervalRef.current) clearInterval(intervalRef.current);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, []);

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

      <SidebarContent>
        {/* story #2681 — 데스크톱 GNB와 모바일 /more 허브(S2)가 한 정의(NAV_GROUPS)에서
            파생된다(doc mobile-ia-full-completion-2678 §2.5-3). 그룹·항목 목록 자체는
            nav-config.ts가 유일한 출처이고, 여기선 오직 순회+렌더만 한다 — 순서·라벨·아이콘·
            그룹핑은 이 리팩터 전과 동일(시각 회귀 0, AC1). */}
        {NAV_GROUPS.map((group) => (
          <SidebarGroup key={group.id}>
            {group.labelKey ? <SidebarGroupLabel>{t(group.labelKey)}</SidebarGroupLabel> : null}
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => {
                  const link = item.kind === 'static'
                    ? { href: item.path, isActive: isActive(item.path) }
                    : resourceLink(item.path);
                  const Icon = item.icon;
                  const badgeCount = item.badgeKey === 'inbox' ? inboxUnreadCount
                    : item.badgeKey === 'chats' ? chatUnreadTotal
                    : 0;
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
                        <span>{label}</span>
                        {item.kbdHint ? <KbdHint>{item.kbdHint}</KbdHint> : null}
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
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter className="space-y-2 p-2">
        {userName && <ProfileMenu name={userName} />}
        <div className="flex items-center justify-between gap-1">
          <div className="flex items-center gap-1">
            <LocaleSwitcher />
            <ThemeToggle />
          </div>
          <Link
            href={docsLink.href}
            aria-label={t('help')}
            title={t('help')}
            className="flex size-8 items-center justify-center rounded-md text-sidebar-foreground/60 transition hover:bg-sidebar-accent hover:text-sidebar-foreground"
          >
            <CircleHelp className="size-4" />
          </Link>
        </div>
      </SidebarFooter>

      <SidebarRail />
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} projectId={projectId} contextStoryId={contextStoryId} />
    </Sidebar>
  );
}
