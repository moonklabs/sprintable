'use client';

import { useTranslations } from 'next-intl';
import { Icon } from '@/components/ds/icon';
import { RAIL_ICON_BY_ITEM_ID } from './rail-icons';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { MoveAgentsEntry, NewProjectEntry } from '@/components/nav/new-project-entry';
import { BusinessInfoDisclosure } from '@/components/nav/business-info-disclosure';
import { ProfileMenu } from '@/components/nav/profile-menu';
import { ThemeToggle } from '@/components/nav/theme-toggle';
import { UnifiedSwitcher, type OrgSwitcherItem } from '@/components/nav/unified-switcher';
import type { DashboardProjectOption } from '@/app/dashboard/dashboard-shell';
import { cn } from '@/lib/utils';

// story #4885 (B 셸) — 막대 맨 아래 «계정» 팝오버. 왼쪽 길잡이(목록 칸)의 머리 · 바닥에만 있던 «쪽이 아닌 입구»를 막대에서도 닿게 한다:
// 조직/프로젝트 전환 · 새 프로젝트(앱) · 에이전트 옮기기(앱) · 프로필 메뉴(이름 설정 · 계정 전환 · 로그아웃) · 언어 · 테마 · 사업자 정보.
// **새 부품 0** — 길잡이가 쓰던 부품을 그대로 옮겨 싣는다(길잡이가 접히는 화면 · 사람이 접어 둔 때에도 이 입구가 사라지지 않게 — /chats가 길잡이를 접는다).
interface RailAccountProps {
  orgId?: string;
  orgMemberships: OrgSwitcherItem[];
  projectId?: string;
  projectMemberships: DashboardProjectOption[];
  userName?: string;
  className?: string;
}

export function RailAccount({ orgId, orgMemberships, projectId, projectMemberships, userName, className }: RailAccountProps) {
  const t = useTranslations('nav');
  const label = t('switcherAccountSectionLabel');
  return (
    <Popover>
      <PopoverTrigger
        aria-label={label}
        title={label}
        className={cn('block rounded-ds-control hover:bg-ds-surface-high focus-visible:ring-2 focus-visible:ring-ds-action', className)}
        data-rail-item="account"
      >
        <span className="flex size-10 items-center justify-center rounded-ds-control text-ds-ink-3 transition-colors">
          <Icon name={RAIL_ICON_BY_ITEM_ID.account!} size={20} />
        </span>
      </PopoverTrigger>
      <PopoverContent side="right" align="end" sideOffset={8} className="flex w-72 flex-col gap-1 p-2" data-testid="rail-account-panel" aria-label={label}>
        <UnifiedSwitcher orgs={orgMemberships} currentOrgId={orgId} projects={projectMemberships} currentProjectId={projectId} className="w-full" />
        <NewProjectEntry className="h-8 min-h-0 w-full justify-start gap-2 px-2.5 text-sm text-muted-foreground" />
        <MoveAgentsEntry className="h-8 min-h-0 w-full justify-start gap-2 px-2.5 text-sm text-muted-foreground" />
        <ProfileMenu name={userName ?? null} triggerClassName="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition hover:bg-muted" />
        <div className="flex items-center gap-1">
          <LocaleSwitcher />
          <ThemeToggle />
        </div>
        <BusinessInfoDisclosure />
      </PopoverContent>
    </Popover>
  );
}
