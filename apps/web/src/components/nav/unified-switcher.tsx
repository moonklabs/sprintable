'use client';

import { firstGraphemes } from '@/lib/first-graphemes';
import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Check, ChevronDown, Loader2, Plus, Settings } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SidebarMenuButton } from '@/components/ui/sidebar';
import { CreateOrganizationDialog } from '@/components/nav/create-organization-dialog';
import { CreateProjectDialog } from '@/components/nav/create-project-dialog';
import { useUnifiedSwitcher, withSwitchedSlugs, type OrgSwitcherItem, type ProjectSwitcherItem } from '@/hooks/use-unified-switcher';
import { orgRoleLabel } from '@/lib/org-member-role';
import { useFlatHref } from '@/hooks/use-flat-href';
import { registerNewProjectOwner } from '@/components/nav/new-project-owner';

// story #2076: 로직(withSwitchedSlugs 포함)이 hooks/use-unified-switcher.ts로 이동했다 —
// 사이드바(UnifiedSwitcher, ≥1024)와 신규 ContextSwitcherChip(top-bar 칩+바텀시트, <1024)이
// 같은 훅을 공유한다. 기존 import 경로(`from './unified-switcher'`)를 깨지 않도록 재-export.
export { withSwitchedSlugs };
export type { OrgSwitcherItem };

interface UnifiedSwitcherProps {
  orgs: OrgSwitcherItem[];
  currentOrgId?: string;
  projects: ProjectSwitcherItem[];
  currentProjectId?: string;
  className?: string;
}

function OrgInitial({ name }: { name: string }) {
  return (
    <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-sm bg-brand text-micro font-semibold text-brand-foreground">
      {firstGraphemes(name, 1).toUpperCase()}
    </span>
  );
}

/**
 * story 5031 (5a-2): the «새 프로젝트» door of the desktop app (the event · the ⌘N flag) opens THIS switcher's dialog when this instance is the owner (new-project-owner.ts decides, by priority).
 * The setter is a new function each render — the registered opener reads the latest (kept after render, never during it).
 */
export function useNewProjectOwner(setCreateProjectOpen: (open: boolean) => void, priority: number): void {
  const latest = useRef(setCreateProjectOpen);
  useEffect(() => { latest.current = setCreateProjectOpen; });
  useEffect(() => registerNewProjectOwner(() => latest.current(true), priority), [priority]);
}

/**
 * story 5031 (5a-2): the INSIDE of the project switcher's menu — the current organization's project lines (check on the current one) · «새 프로젝트» · the other organizations with their projects · «새 조직». One part for the list column's switcher and the desktop top bar's path
 * (its «조직» and «프로젝트» crumbs open this same menu): the menu is written once. The state is the hook's (`useUnifiedSwitcher`) — the part only draws it.
 * `-webkit-app-region: no-drag`: in the desktop app the top bar is the window's drag area and a menu opened under it must not be one (a press on a line would move the window).
 */
export function SwitcherMenuContent({ s, align = 'start', className }: { s: ReturnType<typeof useUnifiedSwitcher>; align?: 'start' | 'center' | 'end'; className?: string }) {
  const flatHref = useFlatHref(); // story #4231 3차 — flat 목적지는 현재 프로젝트(`?p=`)를 싣는다
  const t = useTranslations('nav');
  const tCommon = useTranslations('common');
  const tSettings = useTranslations('settings');
  return (
    <DropdownMenuContent className={cn('w-auto min-w-64 [-webkit-app-region:no-drag]', className)} align={align} side="bottom" sideOffset={4}>
      {/* 현재 조직 */}
      <DropdownMenuGroup>
        <div className="flex items-center justify-between px-2 py-1.5">
          <DropdownMenuLabel className="p-0 text-editorial-meta font-semibold text-muted-foreground uppercase tracking-wide">
            <span className="flex items-center gap-1.5">
              <OrgInitial name={s.displayOrg} />
              {s.displayOrg}
            </span>
          </DropdownMenuLabel>
          <button
            type="button"
            onClick={() => { window.location.href = flatHref('/settings?tab=organization'); }}
            className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label={t('switcherOrgSettingsAria')}
          >
            <Settings className="h-3 w-3" />
          </button>
        </div>
        {/* story #2093 후속 — s.currentOrgProjects(X-Org-Id로 방금 조회한 정본)를 쓴다.
            raw projects prop은 서버 /me/memberships가 JWT "현재 org" 클레임 스코프라
            URL org와 계정 상태 org가 갈리면(cross-org 진입) 다른 org의 프로젝트를
            이 org 소속인 것처럼 보여줄 수 있다. */}
        {s.currentOrgLoading && (
          <div className="flex items-center gap-2 px-5 py-1.5 text-sm text-muted-foreground">
            <Loader2 className="size-ds-icon-sm animate-spin" />
            <span>{tCommon('loading')}</span>
          </div>
        )}
        {s.currentOrgProjects.map((project) => (
          <DropdownMenuItem
            key={project.projectId}
            disabled={s.pending}
            className="pl-5"
            onClick={() => void s.switchProject(project.projectId)}
          >
            <span className="flex-1 truncate text-sm">{project.projectName}</span>
            {project.projectId === s.currentProjectId && (
              <Check className="size-ds-icon-sm shrink-0 text-primary" />
            )}
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem className="pl-5 text-muted-foreground" onClick={() => s.setCreateProjectOpen(true)}>
          <Plus className="size-ds-icon-sm" />
          <span className="text-sm">{t('switcherNewProject')}</span>
        </DropdownMenuItem>
      </DropdownMenuGroup>

      {/* 다른 조직들 — 각 조직 아래에 프로젝트 표시 */}
      {s.otherOrgs.map((org) => {
        const orgProjects = s.otherOrgProjects[org.orgId];
        const isLoading = s.loadingOrgIds.has(org.orgId);
        return (
          <div key={org.orgId}>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <div className="px-2 py-1.5">
                <DropdownMenuLabel className="p-0 text-editorial-meta font-semibold text-muted-foreground uppercase tracking-wide">
                  <span className="flex items-center gap-1.5">
                    <OrgInitial name={org.orgName} />
                    {org.orgName}
                    {org.role && (
                      <span className="text-micro font-normal opacity-60">{orgRoleLabel(org.role, tSettings)}</span>
                    )}
                  </span>
                </DropdownMenuLabel>
              </div>
              {isLoading ? (
                <div className="flex items-center gap-2 pl-5 py-1.5 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  <span>{tCommon('loading')}</span>
                </div>
              ) : orgProjects && orgProjects.length > 0 ? (
                orgProjects.map((project) => (
                  <DropdownMenuItem
                    key={project.projectId}
                    disabled={s.pending}
                    className="pl-5"
                    onClick={() => void s.switchOrgAndProject(org.orgId, project.projectId)}
                  >
                    <span className="flex-1 truncate text-sm">{project.projectName}</span>
                  </DropdownMenuItem>
                ))
              ) : (
                <DropdownMenuItem
                  disabled={s.pending}
                  className="pl-5 text-muted-foreground"
                  onClick={() => void s.switchOrg(org.orgId)}
                >
                  <span className="text-sm">{t('switcherSwitchToOrg')}</span>
                </DropdownMenuItem>
              )}
            </DropdownMenuGroup>
          </div>
        );
      })}

      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={() => s.setCreateOrgOpen(true)}>
        <Plus className="size-ds-icon-sm" />
        <span className="text-sm">{t('switcherNewOrganization')}</span>
      </DropdownMenuItem>
    </DropdownMenuContent>
  );
}

// story #2076: 사이드바 트리거(≥1024)용 UI. 로직은 useUnifiedSwitcher 훅 — 신규
// ContextSwitcherChip(top-bar 칩+바텀시트, <1024)이 같은 훅을 쓰되 컨테이너만 Sheet로 갈아낀다.
export function UnifiedSwitcher({
  orgs,
  currentOrgId,
  projects,
  currentProjectId,
  className,
}: UnifiedSwitcherProps) {
  const s = useUnifiedSwitcher({ orgs, currentOrgId, projects, currentProjectId });
  // story 4832: the sidebar's «새 프로젝트» line (desktop app) opens a project dialog. Story 5031 (5a-2): several switchers can be mounted together (this column · the account popover · the desktop top bar's path) — the event reaches ONE of them (new-project-owner.ts);
  // this one is an ordinary candidate (priority 0), the top bar's is the preferred owner.
  useNewProjectOwner(s.setCreateProjectOpen, 0);

  return (
    <>
      <DropdownMenu open={s.open} onOpenChange={s.setOpen}>
        <DropdownMenuTrigger
          disabled={s.pending}
          render={
            <SidebarMenuButton className={cn('w-full', className)}>
              <OrgInitial name={s.displayOrg} />
              {/* story c4980e70(조직 헤더 1급화): 조직명=primary(굵게)·프로젝트명=secondary로 emphasis 전도 —
                  기존엔 조직명이 10px 보조 라벨이라 "조직명 부재"처럼 읽혔다(doc §1 ①). */}
              <span className="flex min-w-0 flex-1 flex-col truncate text-left">
                <span className="truncate text-xs font-semibold text-foreground leading-tight">
                  {s.displayOrg}
                </span>
                {/* 0746: 전환 중에는 옛 org의 프로젝트명을 숨겨 "새 org + 옛 프로젝트" 깜빡임(leak처럼 보임)을 차단 */}
                {!s.pending && s.displayProject && (
                  <span className="truncate text-micro font-medium text-muted-foreground leading-tight">
                    {s.displayProject}
                  </span>
                )}
              </span>
              <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
            </SidebarMenuButton>
          }
        />
        <SwitcherMenuContent s={s} />
      </DropdownMenu>

      {/* story #2544 — org 전환 실패를 명시(침묵 실패 금지, #2468과 동일 원칙). DropdownMenuItem
          클릭이 메뉴를 즉시 닫으므로 메뉴 바깥(트리거 인접)에 둬 닫힌 뒤에도 보이게 한다. */}
      {s.switchOrgError && (
        <p role="alert" className="mt-1 px-1 text-xs text-destructive">{s.switchOrgError}</p>
      )}

      <CreateOrganizationDialog
        open={s.createOrgOpen}
        onOpenChange={s.setCreateOrgOpen}
        onCreated={s.handleOrgCreated}
      />

      <CreateProjectDialog s={s} />
    </>
  );
}
