'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  BookOpen,
  Bot,
  ChevronDown,
  ChevronRight,
  FolderKanban,
  Gauge,
  Gift,
  Inbox,
  MessageSquareMore,
  PenTool,
  Search,
  Settings,
  Users,
} from 'lucide-react';
import { SprintableLogo } from '@/components/brand/sprintable-logo';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { MemoSidebar } from '@/components/memos/memo-sidebar';
import { ProjectSwitcher } from '@/components/nav/project-switcher';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { GlassPanel } from '@/components/ui/glass-panel';
import { OperatorIconButton } from '@/components/ui/operator-icon-button';
import { cn } from '@/lib/utils';

type NavItem = {
  key: string;
  icon: typeof FolderKanban;
  href?: string;
  children?: Array<{ key: string; href: string; icon: typeof FolderKanban }>;
};

const NAV_ITEMS: NavItem[] = [
  {
    key: 'sprintManagement',
    icon: FolderKanban,
    children: [
      { key: 'board', href: '/board', icon: FolderKanban },
      { key: 'standup', href: '/standup', icon: Users },
      { key: 'retro', href: '/retro', icon: Gauge },
    ],
  },
  { key: 'docs', href: '/docs', icon: BookOpen },
  { key: 'memos', href: '/memos', icon: MessageSquareMore },
  { key: 'mockup', href: '/mockups', icon: PenTool },
  { key: 'agents', href: '/agents', icon: Bot },
  { key: 'settings', href: '/settings', icon: Settings },
];

// Mobile bottom nav용 (1depth 핵심 메뉴만)
const MOBILE_NAV_ITEMS = [
  { key: 'board', href: '/board', icon: FolderKanban },
  { key: 'docs', href: '/docs', icon: BookOpen },
  { key: 'memos', href: '/memos', icon: MessageSquareMore },
  { key: 'mockup', href: '/mockups', icon: PenTool },
  { key: 'settings', href: '/settings', icon: Settings },
] as const;

export function OperatorShell({
  currentTeamMemberId,
  projectId,
  projectName,
  projectMemberships,
  children,
}: {
  currentTeamMemberId?: string;
  projectId?: string;
  projectName?: string;
  projectMemberships: Array<{ projectId: string; projectName: string }>;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const t = useTranslations('nav');
  const shellT = useTranslations('shell');
  const [memoUnreadCount, setMemoUnreadCount] = useState(0);
  const [memoSidebarOpen, setMemoSidebarOpen] = useState(false);
  const [expandedMenus, setExpandedMenus] = useState<Set<string>>(new Set(['sprintManagement']));

  useEffect(() => {
    async function fetchUnread() {
      try {
        const [memoRes] = await Promise.all([
          fetch('/api/notifications?unread=true&type=memo'),
        ]);
        if (memoRes.ok) {
          const json = await memoRes.json();
          setMemoUnreadCount(json.meta?.unreadCount ?? 0);
        }
      } catch {
        // noop
      }
    }

    void fetchUnread();
    const interval = setInterval(fetchUnread, 30000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="min-h-screen bg-[color:var(--operator-bg)] text-[color:var(--operator-foreground)]">
      <div className="flex min-h-screen">
        <aside className="hidden w-72 shrink-0 p-4 lg:block">
          <GlassPanel className="flex h-[calc(100vh-2rem)] flex-col gap-6 px-4 py-6">
            <div className="px-2">
              <div className="space-y-1.5">
                <Link href="/dashboard" className="inline-flex">
                  <SprintableLogo
                    variant="horizontal"
                    className="text-[color:var(--operator-foreground)]"
                    markClassName="h-7"
                    wordmarkClassName="text-[0.88rem] tracking-[0.14em]"
                  />
                </Link>
                <div className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[color:var(--operator-muted)]">{shellT('workspaceLabel')}</div>
              </div>
            </div>

            <nav className="flex-1 space-y-1">
              {NAV_ITEMS.map((item) => {
                const Icon = item.icon;

                if (item.children) {
                  // 하위 메뉴가 있는 그룹 (e.g. Sprint Management)
                  const isExpanded = expandedMenus.has(item.key);
                  const hasActiveChild = item.children.some(
                    (child) => pathname === child.href || pathname.startsWith(child.href)
                  );

                  return (
                    <div key={item.key} className="space-y-1">
                      <button
                        onClick={() => {
                          const next = new Set(expandedMenus);
                          if (isExpanded) {
                            next.delete(item.key);
                          } else {
                            next.add(item.key);
                          }
                          setExpandedMenus(next);
                        }}
                        className={cn(
                          'group flex w-full items-center justify-between rounded-2xl px-3 py-2.5 text-sm font-medium transition-all duration-200',
                          hasActiveChild
                            ? 'bg-primary/10 text-primary font-semibold'
                            : 'text-[color:var(--operator-muted)] hover:bg-white/5 hover:text-[color:var(--operator-foreground)]',
                        )}
                      >
                        <span className="flex items-center gap-3">
                          <Icon className="size-4.5" />
                          <span>{t(item.key)}</span>
                        </span>
                        {isExpanded ? (
                          <ChevronDown className="size-3.5" />
                        ) : (
                          <ChevronRight className="size-3.5" />
                        )}
                      </button>

                      {isExpanded && (
                        <div className="ml-6 space-y-1 border-l border-white/8 pl-3">
                          {item.children.map((child) => {
                            const ChildIcon = child.icon;
                            const isChildActive = pathname === child.href || pathname.startsWith(child.href);
                            return (
                              <Link
                                key={child.href}
                                href={child.href}
                                className={cn(
                                  'group flex items-center gap-3 rounded-2xl px-3 py-2 text-sm font-medium transition-all duration-200',
                                  isChildActive
                                    ? 'bg-primary/10 text-primary font-semibold'
                                    : 'text-[color:var(--operator-muted)] hover:bg-white/5 hover:text-[color:var(--operator-foreground)]',
                                )}
                              >
                                <ChildIcon className="size-4" />
                                <span>{t(child.key)}</span>
                              </Link>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                }

                // 하위 메뉴가 없는 일반 링크
                const isActive = pathname === item.href || (item.href !== '/dashboard' && pathname.startsWith(item.href!));
                return (
                  <Link
                    key={item.href}
                    href={item.href!}
                    className={cn(
                      'group flex items-center justify-between rounded-2xl px-3 py-2.5 text-sm font-medium transition-all duration-200',
                      isActive
                        ? 'bg-primary/10 text-primary font-semibold'
                        : 'text-[color:var(--operator-muted)] hover:bg-white/5 hover:text-[color:var(--operator-foreground)]',
                    )}
                  >
                    <span className="flex items-center gap-3">
                      <Icon className="size-4.5" />
                      <span>{t(item.key)}</span>
                    </span>
                  </Link>
                );
              })}
            </nav>

            <div className="space-y-3 border-t border-white/8 pt-4">
              <LocaleSwitcher className="px-1" />
              <Button variant="hero" size="lg" className="w-full justify-start" render={<Link href="/board" />} nativeButton={false}>
                <Gift className="size-4" />
                {shellT('primaryCta')}
              </Button>
              <Button variant="glass" size="lg" className="w-full justify-start" render={<Link href="/dashboard/settings" />} nativeButton={false}>
                <Settings className="size-4" />
                {t('settings')}
              </Button>
            </div>
          </GlassPanel>
        </aside>

        <div className="flex min-h-screen min-w-0 flex-1 flex-col px-2 sm:px-4 lg:px-5 lg:pb-5" style={{ paddingBottom: 'max(5rem, calc(env(safe-area-inset-bottom) + 4rem))' }}>
          <GlassPanel className="sticky top-0 z-30 mb-4 -mx-2 rounded-none sm:-mx-4 lg:-mx-5 flex items-center justify-between gap-4 px-4 py-2 lg:py-3">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <div className="shrink-0 whitespace-nowrap text-[10px] font-semibold uppercase tracking-[0.24em] text-[color:var(--operator-muted)]">{shellT('projectLabel')}</div>
              {projectMemberships.length > 0 ? (
                <div className="min-w-0 flex-1 lg:hidden">
                  <ProjectSwitcher
                    projects={projectMemberships}
                    currentProjectId={projectId}
                    className="min-h-[44px] w-full"
                  />
                </div>
              ) : null}
              {projectMemberships.length === 0 ? (
                <div className="truncate font-heading text-sm font-bold text-[color:var(--operator-foreground)]">
                  {projectName ?? (projectId ? shellT('projectAttached') : shellT('projectPending'))}
                </div>
              ) : null}
            </div>
            <div className="hidden max-w-xl flex-1 items-center gap-3 lg:flex">
              {projectMemberships.length > 0 ? (
                <ProjectSwitcher
                  projects={projectMemberships}
                  currentProjectId={projectId}
                  className="w-[240px]"
                />
              ) : null}
              <div className="flex min-w-0 flex-1 items-center gap-2 rounded-full border border-white/8 bg-[color:var(--operator-surface-soft)] px-4 py-2 text-sm text-[color:var(--operator-muted)]">
                <Search className="size-4 shrink-0" />
                <span className="truncate">{shellT('searchPlaceholder')}</span>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <OperatorIconButton
                onClick={() => {
                  setMemoSidebarOpen(true);
                  setMemoUnreadCount(0);
                }}
                aria-label={t('memos')}
                className="relative hidden lg:flex"
              >
                <MessageSquareMore className="size-4" />
                {memoUnreadCount > 0 ? <Badge variant="counter" className="absolute -right-1 -top-1 h-5 min-w-5 px-1.5 text-[10px]">{memoUnreadCount > 9 ? '9+' : memoUnreadCount}</Badge> : null}
              </OperatorIconButton>
              <OperatorIconButton render={<Link href="/inbox" />} nativeButton={false} aria-label={t('inbox')} className="hidden lg:flex">
                <Inbox className="size-4" />
              </OperatorIconButton>
              <OperatorIconButton render={<Link href="/dashboard/settings" />} nativeButton={false} aria-label={t('settings')} className="hidden lg:flex">
                <Settings className="size-4" />
              </OperatorIconButton>
            </div>
          </GlassPanel>

          <div className="min-w-0 flex-1">{children}</div>
        </div>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-40 lg:hidden">
        <GlassPanel className="grid grid-cols-5 gap-1 rounded-none px-2 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          {MOBILE_NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive = pathname === item.href || pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'flex min-h-[44px] flex-col items-center justify-center gap-1 rounded-2xl px-2 py-2 text-[11px] font-medium',
                  isActive ? 'bg-primary/10 text-primary' : 'text-muted-foreground',
                )}
              >
                <Icon className="size-4" />
                <span className="truncate">{t(item.key)}</span>
              </Link>
            );
          })}
        </GlassPanel>
      </div>

      <MemoSidebar open={memoSidebarOpen} onClose={() => setMemoSidebarOpen(false)} currentTeamMemberId={currentTeamMemberId} projectId={projectId} />
    </div>
  );
}
