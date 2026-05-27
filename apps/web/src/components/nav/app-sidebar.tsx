'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  BookOpen,
  Bot,
  CalendarDays,
  CircleHelp,
  ClipboardList,
  FolderKanban,
  Gauge,
  Inbox,
  Layers,
  LayoutDashboard,
  MessageSquare,
  Search,
  Settings,
  Users,
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
} from '@/components/ui/sidebar';

interface AppSidebarProps {
  currentTeamMemberId?: string;
  orgId?: string;
  orgMemberships?: OrgSwitcherItem[];
  projectId?: string;
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
  projectMemberships,
  userName,
}: AppSidebarProps) {
  const pathname = usePathname();
  const t = useTranslations('nav');
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
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
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

        <SidebarGroup>
          <SidebarGroupLabel>{t('sprint')}</SidebarGroupLabel>
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
                  render={<Link href="/epics" />}
                  isActive={isActive('/epics')}
                  tooltip={t('epics')}
                >
                  <Layers />
                  <span>{t('epics')}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  render={<Link href="/standup" />}
                  isActive={isActive('/standup')}
                  tooltip={t('standup')}
                >
                  <Users />
                  <span>{t('standup')}</span>
                  <KbdHint>S</KbdHint>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  render={<Link href="/retro" />}
                  isActive={isActive('/retro')}
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

        <SidebarGroup>
          <SidebarGroupLabel>{t('workspace')}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  render={<Link href="/docs" />}
                  isActive={isActive('/docs')}
                  tooltip={t('docs')}
                >
                  <BookOpen />
                  <span>{t('docs')}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  render={<Link href="/meetings" />}
                  isActive={isActive('/meetings')}
                  tooltip={t('meetings')}
                >
                  <CalendarDays />
                  <span>{t('meetings')}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  render={<Link href="/agents" />}
                  isActive={isActive('/agents')}
                  tooltip={t('agents')}
                >
                  <Bot />
                  <span>{t('agents')}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
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

        <SidebarGroup>
          <SidebarGroupLabel>{t('configure')}</SidebarGroupLabel>
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
            href="/docs"
            aria-label={t('help')}
            title={t('help')}
            className="flex size-8 items-center justify-center rounded-md text-sidebar-foreground/60 transition hover:bg-sidebar-accent hover:text-sidebar-foreground"
          >
            <CircleHelp className="size-4" />
          </Link>
        </div>
      </SidebarFooter>

      <SidebarRail />
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} projectId={projectId} />
    </Sidebar>
  );
}
