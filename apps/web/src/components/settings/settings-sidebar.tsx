'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

interface SettingsSidebarProps {
  isAdmin: boolean;
  currentProjectId?: string;
}

interface NavGroup {
  key: string;
  titleKey: string;
  items: NavItem[];
}

interface NavItem {
  key: string;
  labelKey: string;
  hash: string;
  adminOnly?: boolean;
  projectOnly?: boolean;
}

const NAV_GROUPS: NavGroup[] = [
  {
    key: 'personal',
    titleKey: 'personalSettings',
    items: [
      { key: 'notifications', labelKey: 'notifications', hash: '#notifications' },
      { key: 'danger', labelKey: 'dangerZone', hash: '#danger-zone' },
    ],
  },
  {
    key: 'project',
    titleKey: 'projectSettings',
    items: [
      { key: 'members', labelKey: 'memberManagement', hash: '#members', adminOnly: true, projectOnly: true },
      { key: 'webhooks', labelKey: 'webhooks', hash: '#webhooks' },
      { key: 'ai', labelKey: 'aiSettings', hash: '#ai', projectOnly: true },
      { key: 'mcp', labelKey: 'mcpConnectionsLabel', hash: '#mcp', projectOnly: true },
      { key: 'byom', labelKey: 'byomKeys', hash: '#byom', projectOnly: true },
      { key: 'slack', labelKey: 'slackIntegration', hash: '#slack' },
    ],
  },
  {
    key: 'organization',
    titleKey: 'organizationSettings',
    items: [
      { key: 'projects', labelKey: 'projectManagement', hash: '#projects' },
      { key: 'invitations', labelKey: 'inviteMembers', hash: '#invitations', adminOnly: true },
      { key: 'subscription', labelKey: 'manageSubscription', hash: '#subscription', adminOnly: true },
      { key: 'billing', labelKey: 'billing', hash: '/settings/billing' },
      { key: 'usage', labelKey: 'usage', hash: '/settings/usage' },
    ],
  },
];

export function SettingsSidebar({ isAdmin, currentProjectId }: SettingsSidebarProps) {
  const t = useTranslations('settings');
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    new Set(['personal', 'project', 'organization'])
  );

  const toggleGroup = (groupKey: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) {
        next.delete(groupKey);
      } else {
        next.add(groupKey);
      }
      return next;
    });
  };

  const isActive = (hash: string) => {
    if (hash.startsWith('/settings/')) {
      return pathname === hash;
    }
    if (typeof window === 'undefined') return false;
    return window.location.hash === hash;
  };

  return (
    <nav className="w-64 flex-shrink-0 space-y-6 p-6">
      {NAV_GROUPS.map((group) => {
        const isExpanded = expandedGroups.has(group.key);
        const visibleItems = group.items.filter((item) => {
          if (item.adminOnly && !isAdmin) return false;
          if (item.projectOnly && !currentProjectId) return false;
          return true;
        });

        if (visibleItems.length === 0) return null;

        return (
          <div key={group.key}>
            <button
              onClick={() => toggleGroup(group.key)}
              className="flex w-full items-center justify-between text-xs font-medium uppercase tracking-[0.18em] text-[color:var(--operator-muted)] hover:text-[color:var(--operator-foreground)] transition"
            >
              {t(group.titleKey)}
              {isExpanded ? (
                <ChevronDown className="size-3.5" />
              ) : (
                <ChevronRight className="size-3.5" />
              )}
            </button>
            {isExpanded && (
              <div className="mt-2 space-y-1">
                {visibleItems.map((item) => {
                  const active = isActive(item.hash);
                  const isExternalRoute = item.hash.startsWith('/settings/');

                  if (isExternalRoute) {
                    return (
                      <Link
                        key={item.key}
                        href={item.hash}
                        className={cn(
                          'block rounded-lg px-3 py-2 text-sm transition',
                          active
                            ? 'bg-[color:var(--operator-primary)]/14 text-[color:var(--operator-primary-soft)] shadow-[inset_0_0_0_1px_rgba(182,196,255,0.14)]'
                            : 'text-[color:var(--operator-foreground)]/88 hover:bg-white/6 hover:text-[color:var(--operator-foreground)]'
                        )}
                      >
                        {t(item.labelKey)}
                      </Link>
                    );
                  }

                  return (
                    <a
                      key={item.key}
                      href={item.hash}
                      className={cn(
                        'block rounded-lg px-3 py-2 text-sm transition',
                        active
                          ? 'bg-[color:var(--operator-primary)]/14 text-[color:var(--operator-primary-soft)] shadow-[inset_0_0_0_1px_rgba(182,196,255,0.14)]'
                          : 'text-[color:var(--operator-foreground)]/88 hover:bg-white/6 hover:text-[color:var(--operator-foreground)]'
                      )}
                      onClick={(e) => {
                        e.preventDefault();
                        const target = document.querySelector(item.hash);
                        if (target) {
                          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
                          window.history.replaceState(null, '', item.hash);
                        }
                      }}
                    >
                      {t(item.labelKey)}
                    </a>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}
