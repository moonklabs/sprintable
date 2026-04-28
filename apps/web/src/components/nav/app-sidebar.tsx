'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  BookOpen,
  Bot,
  CalendarDays,
  CircleHelp,
  FolderKanban,
  Gauge,
  Inbox,
  LayoutDashboard,
  MessageSquareMore,
  Search,
  Settings,
  Users,
} from 'lucide-react';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { CommandPalette } from '@/components/command-palette/command-palette';
import { ProjectSwitcher } from '@/components/nav/project-switcher';
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
  projectId?: string;
  projectName?: string;
  projectMemberships: Array<{ projectId: string; projectName: string }>;
}

function KbdHint({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="ml-auto hidden rounded border border-sidebar-border/60 bg-sidebar-accent/40 px-1.5 py-0 font-mono text-[10px] font-medium text-sidebar-foreground/60 group-data-[active=true]/menu-button:text-sidebar-foreground/80 sm:inline-flex">
      {children}
    </kbd>
  );
}

export function AppSidebar({
  projectId,
  projectName,
  projectMemberships,
}: AppSidebarProps) {
  const pathname = usePathname();
  const t = useTranslations('nav');
  const [memoUnreadCount, setMemoUnreadCount] = useState(0);
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

  useEffect(() => {
    async function fetchUnread() {
      try {
        const [memoRes, inboxRes] = await Promise.all([
          fetch('/api/notifications?unread=true&type=memo'),
          fetch('/api/notifications?unread=true'),
        ]);
        if (memoRes.ok) {
          const json = await memoRes.json() as { meta?: { unreadCount?: number } };
          setMemoUnreadCount(json.meta?.unreadCount ?? 0);
        }
        if (inboxRes.ok) {
          const json = await inboxRes.json() as { meta?: { unreadCount?: number } };
          setInboxUnreadCount(json.meta?.unreadCount ?? 0);
        }
      } catch {
        // noop
      }
    }
    void fetchUnread();
    const interval = setInterval(fetchUnread, 30000);
    return () => clearInterval(interval);
  }, []);

  function isActive(href: string) {
    return pathname === href || (href !== '/' && pathname.startsWith(href));
  }

  return (
    <Sidebar variant="inset" collapsible="offcanvas">
      <SidebarHeader className="py-3">
        {projectMemberships.length > 0 ? (
          <ProjectSwitcher
            projects={projectMemberships}
            currentProjectId={projectId}
            className="w-full"
          />
        ) : (
          <div className="truncate px-2 py-1 text-sm font-medium text-sidebar-foreground">
            {projectName ?? 'Sprintable'}
          </div>
        )}
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
                  render={<Link href="/memos" />}
                  isActive={isActive('/memos')}
                  tooltip={t('memos')}
                >
                  <MessageSquareMore />
                  <span>{t('memos')}</span>
                  {memoUnreadCount > 0 ? (
                    <SidebarMenuBadge>
                      {memoUnreadCount > 9 ? '9+' : memoUnreadCount}
                    </SidebarMenuBadge>
                  ) : null}
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

      <SidebarFooter className="p-2">
        <div className="flex items-center justify-between gap-2">
          <LocaleSwitcher />
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
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </Sidebar>
  );
}
