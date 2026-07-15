'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  Award,
  BookOpen,
  Bot,
  Brain,
  CalendarRange,
  CircleHelp,
  ClipboardList,
  FlaskConical,
  FolderKanban,
  GalleryVerticalEnd,
  Gauge,
  HardDrive,
  Inbox,
  Layers,
  LayoutDashboard,
  Map,
  MessageSquare,
  Newspaper,
  Search,
  Settings,
  Shield,
  Users,
  Users2,
} from 'lucide-react';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { ThemeToggle } from '@/components/nav/theme-toggle';
import { CommandPalette } from '@/components/command-palette/command-palette';
import { ProfileMenu } from '@/components/nav/profile-menu';
import { UnifiedSwitcher, type OrgSwitcherItem } from '@/components/nav/unified-switcher';
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
  currentTeamMemberId?: string;
  orgId?: string;
  orgMemberships?: OrgSwitcherItem[];
  projectId?: string;
  // story a539c649 S2: 문서 바로가기가 /{ws}/{proj}/docs 직접 path 를 만드는 데만 쓴다 — 없으면
  // bare `/docs`로 폴백(미들웨어 리다이렉트 안전망이 받음).
  currentProjectSlug?: string;
  projectMemberships: Array<{ projectId: string; projectName: string }>;
  userName?: string;
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
  const docsLink = resourceLink('docs');
  const standupLink = resourceLink('standup');
  const retroLink = resourceLink('retro');
  const loopsLink = resourceLink('loops');
  const artifactsLink = resourceLink('artifacts');
  const sprintsLink = resourceLink('sprints');
  const storageLink = resourceLink('storage');
  const epicsLink = resourceLink('epics');
  const t = useTranslations('nav');
  const { isMobile, setOpenMobile } = useSidebar();
  // ⌘K 액션 확장(story 4f991165) — 스토리 상세(`/board?story={id}`)에서 열렸을 때만 context 주입.
  const contextStoryId = pathname === '/board' ? (searchParams.get('story') ?? undefined) : undefined;

  // 4dad38d3: 모바일 nav 아이템 선택 후 드로어 auto-close. route 변경 시 닫는다(전 아이템 DRY 커버).
  // 데스크탑은 isMobile 가드로 no-op·백드롭 탭 닫기(Sheet onOpenChange)는 무영향.
  useEffect(() => {
    if (isMobile) setOpenMobile(false);
  }, [pathname, isMobile, setOpenMobile]);

  const [inboxUnreadCount, setInboxUnreadCount] = useState(0);
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
        const res = await fetch('/api/notifications/count');
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
        {/* 조직 / Organization — 주체·구조 프레임(4구역=주의 모드와 별개 축). story c4980e70·
            doc org-1st-class-surface-ia-design-b §1(다이어그램=조직이 4구역 위 프레임 — 유나
            가디언 fix로 최상단 배치). 에이전트=1급 멤버·조직/워크포스 1차 홈(🔒확定).
            신뢰·기억은 C 트랙 전 자리(slot)만 — no-fiction. */}
        <SidebarGroup>
          <SidebarGroupLabel>{t('zoneOrganization')}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  render={<Link href="/organization/members" />}
                  isActive={isActive('/organization/members')}
                  tooltip={t('orgMembers')}
                >
                  <Users2 />
                  <span>{t('orgMembers')}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  render={<Link href="/organization/workforce" />}
                  isActive={isActive('/organization/workforce')}
                  tooltip={t('workforce')}
                >
                  <Bot />
                  <span>{t('workforce')}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  render={<Link href="/organization/roles" />}
                  isActive={isActive('/organization/roles')}
                  tooltip={t('orgRoles')}
                >
                  <Shield />
                  <span>{t('orgRoles')}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  render={<Link href="/organization/trust" />}
                  isActive={isActive('/organization/trust')}
                  tooltip={t('orgTrust')}
                >
                  <Award />
                  <span>{t('orgTrust')}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  render={<Link href="/organization/memory" />}
                  isActive={isActive('/organization/memory')}
                  tooltip={t('orgMemory')}
                >
                  <Brain />
                  <span>{t('orgMemory')}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* ① 지금 / Now — 개입할 것(인박스·대시보드·채팅). ia-4zone SSOT 확定. */}
        <SidebarGroup>
          <SidebarGroupLabel>{t('zoneNow')}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  render={<Link href="/org-briefing" />}
                  isActive={isActive('/org-briefing')}
                  tooltip={t('orgBriefing')}
                >
                  <Newspaper />
                  <span>{t('orgBriefing')}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  render={<Link href="/inbox" />}
                  isActive={isActive('/inbox')}
                  tooltip={t('inbox')}
                >
                  <Inbox />
                  <span>{t('inbox')}</span>
                  {inboxUnreadCount > 0 ? (
                    <SidebarMenuBadge>
                      {inboxUnreadCount > 9 ? '9+' : inboxUnreadCount}
                    </SidebarMenuBadge>
                  ) : null}
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  render={<Link href="/dashboard" />}
                  isActive={isActive('/dashboard')}
                  tooltip={t('dashboard')}
                >
                  <LayoutDashboard />
                  <span>{t('dashboard')}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  render={<Link href="/chats" />}
                  isActive={isActive('/chats')}
                  tooltip={t('chats')}
                >
                  <MessageSquare />
                  <span>{t('chats')}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* ② 작업 / Work — 흐르는 일(보드·스프린트·에픽·현황판·Loop·스탠드업·회고). ia-4zone SSOT 확定. */}
        <SidebarGroup>
          <SidebarGroupLabel>{t('zoneWork')}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  render={<Link href="/board" />}
                  isActive={isActive('/board')}
                  tooltip={t('board')}
                >
                  <FolderKanban />
                  <span>{t('board')}</span>
                  <KbdHint>B</KbdHint>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  render={<Link href={sprintsLink.href} />}
                  isActive={sprintsLink.isActive}
                  tooltip={t('sprints')}
                >
                  <CalendarRange />
                  <span>{t('sprints')}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  render={<Link href={epicsLink.href} />}
                  isActive={epicsLink.isActive}
                  tooltip={t('epics')}
                >
                  <Layers />
                  <span>{t('epics')}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  render={<Link href="/glance" />}
                  isActive={isActive('/glance')}
                  tooltip={t('glance')}
                >
                  <Map />
                  <span>{t('glance')}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  render={<Link href={loopsLink.href} />}
                  isActive={loopsLink.isActive}
                  tooltip={t('loops')}
                >
                  <FlaskConical />
                  <span>{t('loops')}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  render={<Link href={standupLink.href} />}
                  isActive={standupLink.isActive}
                  tooltip={t('standup')}
                >
                  <Users />
                  <span>{t('standup')}</span>
                  <KbdHint>S</KbdHint>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  render={<Link href={retroLink.href} />}
                  isActive={retroLink.isActive}
                  tooltip={t('retro')}
                >
                  <Gauge />
                  <span>{t('retro')}</span>
                  <KbdHint>R</KbdHint>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* ③ 신뢰 / Trust — 증명된 일(활동 로그·감사). 검증 표면 확장 자리(ia-4zone SSOT 확定). */}
        <SidebarGroup>
          <SidebarGroupLabel>{t('zoneTrust')}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  render={<Link href="/activity" />}
                  isActive={isActive('/activity')}
                  tooltip={t('activity')}
                >
                  <ClipboardList />
                  <span>{t('activity')}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* ④ 지식 / Knowledge — 팀 기억(문서·산출물·스토리지·에이전트). ia-4zone SSOT 확定.
            산출물(story a15cea4f) — 스토리 귀속 ArtifactSection과 별개인 모아보기 발견 표면. */}
        <SidebarGroup>
          <SidebarGroupLabel>{t('zoneKnowledge')}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  render={<Link href={docsLink.href} />}
                  isActive={docsLink.isActive}
                  tooltip={t('docs')}
                >
                  <BookOpen />
                  <span>{t('docs')}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  render={<Link href={artifactsLink.href} />}
                  isActive={artifactsLink.isActive}
                  tooltip={t('artifacts')}
                >
                  <GalleryVerticalEnd />
                  <span>{t('artifacts')}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  render={<Link href={storageLink.href} />}
                  isActive={storageLink.isActive}
                  tooltip={t('storage')}
                >
                  <HardDrive />
                  <span>{t('storage')}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              {/* E-SETTINGS S5: Meetings 메뉴 숨김 — /meetings 진입 차단(route thin guard 404). */}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* 설정 — zone 밖·하단(ia-4zone 확定: 유틸 푸터·zone 라벨 없음). */}
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  render={<Link href="/settings" />}
                  isActive={isActive('/settings')}
                  tooltip={t('settings')}
                >
                  <Settings />
                  <span>{t('settings')}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
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
