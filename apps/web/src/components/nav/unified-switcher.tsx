'use client';

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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { SidebarMenuButton } from '@/components/ui/sidebar';
import { CreateOrganizationDialog } from '@/components/nav/create-organization-dialog';
import { useUnifiedSwitcher, withSwitchedSlugs, type OrgSwitcherItem, type ProjectSwitcherItem } from '@/hooks/use-unified-switcher';

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
    <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-sm bg-brand text-[9px] font-semibold text-brand-foreground">
      {name.charAt(0).toUpperCase()}
    </span>
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
  const t = useTranslations('nav');
  const tCommon = useTranslations('common');
  const s = useUnifiedSwitcher({ orgs, currentOrgId, projects, currentProjectId });

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
                  <span className="truncate text-[10px] font-medium text-muted-foreground leading-tight">
                    {s.displayProject}
                  </span>
                )}
              </span>
              <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
            </SidebarMenuButton>
          }
        />
        <DropdownMenuContent className="w-auto min-w-64" align="start" side="bottom" sideOffset={4}>
          {/* 현재 조직 */}
          <DropdownMenuGroup>
            <div className="flex items-center justify-between px-2 py-1.5">
              <DropdownMenuLabel className="p-0 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
                <span className="flex items-center gap-1.5">
                  <OrgInitial name={s.displayOrg} />
                  {s.displayOrg}
                </span>
              </DropdownMenuLabel>
              <button
                type="button"
                onClick={() => { window.location.href = '/settings?tab=organization'; }}
                className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                aria-label={t('switcherOrgSettingsAria')}
              >
                <Settings className="h-3 w-3" />
              </button>
            </div>
            {projects.map((project) => (
              <DropdownMenuItem
                key={project.projectId}
                disabled={s.pending}
                className="pl-5"
                onClick={() => void s.switchProject(project.projectId)}
              >
                <span className="flex-1 truncate text-sm">{project.projectName}</span>
                {project.projectId === s.currentProjectId && (
                  <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
                )}
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem className="pl-5 text-muted-foreground" onClick={() => s.setCreateProjectOpen(true)}>
              <Plus className="h-3.5 w-3.5" />
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
                    <DropdownMenuLabel className="p-0 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
                      <span className="flex items-center gap-1.5">
                        <OrgInitial name={org.orgName} />
                        {org.orgName}
                        {org.role && (
                          <span className="text-[9px] font-normal capitalize normal-case opacity-60">{org.role}</span>
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
            <Plus className="h-3.5 w-3.5" />
            <span className="text-sm">{t('switcherNewOrganization')}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <CreateOrganizationDialog
        open={s.createOrgOpen}
        onOpenChange={s.setCreateOrgOpen}
        onCreated={s.handleOrgCreated}
      />

      <Dialog open={s.createProjectOpen} onOpenChange={s.setCreateProjectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('switcherNewProjectDialogTitle')}</DialogTitle>
          </DialogHeader>
          <form onSubmit={(e) => { e.preventDefault(); void s.createProject(s.newProjectName, s.newProjectDesc); }} className="space-y-3">
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="unified-proj-name">
                {t('switcherProjectNameLabel')} <span className="text-destructive">*</span>
              </label>
              <input
                id="unified-proj-name"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                placeholder={t('switcherProjectNamePlaceholder')}
                value={s.newProjectName}
                onChange={(e) => s.setNewProjectName(e.target.value)}
                required
                autoFocus
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="unified-proj-desc">
                {t('switcherDescriptionLabel')} <span className="text-muted-foreground text-xs">{t('switcherOptionalLabel')}</span>
              </label>
              <textarea
                id="unified-proj-desc"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                placeholder={t('switcherProjectDescPlaceholder')}
                rows={3}
                value={s.newProjectDesc}
                onChange={(e) => s.setNewProjectDesc(e.target.value)}
              />
            </div>
            <DialogFooter>
              <DialogClose render={<Button type="button" variant="ghost" disabled={s.creating}>{tCommon('cancel')}</Button>} />
              <Button type="submit" disabled={!s.newProjectName.trim() || s.creating}>
                {s.creating ? t('switcherCreating') : t('switcherCreateButton')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
