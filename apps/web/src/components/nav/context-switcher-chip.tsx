'use client';

import { useTranslations } from 'next-intl';
import { Check, ChevronDown, Loader2, Plus, Settings } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { CreateOrganizationDialog } from '@/components/nav/create-organization-dialog';
import { useUnifiedSwitcher, type OrgSwitcherItem, type ProjectSwitcherItem } from '@/hooks/use-unified-switcher';

interface ContextSwitcherChipProps {
  orgs: OrgSwitcherItem[];
  currentOrgId?: string;
  projects: ProjectSwitcherItem[];
  currentProjectId?: string;
}

function OrgInitial({ name }: { name: string }) {
  return (
    <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-sm bg-brand text-[9px] font-semibold text-brand-foreground">
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

/**
 * story #2076 — top-bar 좌상단 컨텍스트 칩(<1024 전용, `lg:hidden`). 현재 조직/프로젝트를
 * 상시 표시("여기가 어디인지" 라벨 겸)하고 탭하면 전환 바텀시트를 연다. 로직은
 * useUnifiedSwitcher(사이드바 UnifiedSwitcher와 동일 훅) — 전환 자체는 새로 구현하지 않고
 * 재사용한다(#2039 AC4가 고친 slug-path 보존·optimistic rollback을 그대로 물려받는다).
 *
 * ⚠️ PO 순서 지시: 이 칩은 기존 "More → Settings → 구 GNB" 경로와 **공존**한다. 구 경로 제거는
 * 이 칩이 배포·라이브 확認된 뒤 별도 후속으로 진행한다(둘 다 한 번에 바꾸면 전환 경로가
 * 잠깐 0이 되는 위험).
 */
export function ContextSwitcherChip({ orgs, currentOrgId, projects, currentProjectId }: ContextSwitcherChipProps) {
  const t = useTranslations('nav');
  const tCommon = useTranslations('common');
  const s = useUnifiedSwitcher({ orgs, currentOrgId, projects, currentProjectId });

  // 유나 칩 표시 규격 미도착 — PO 폴백 지시: 조직 › 프로젝트 둘 다 표시(선생님이 "어느
  // 컨텍스트인지 모름"이라 하셨으므로 하나만 보이면 그 결함이 재발한다).
  const chipLabel = s.displayProject ? `${s.displayOrg} › ${s.displayProject}` : s.displayOrg;

  return (
    <>
      <Sheet open={s.open} onOpenChange={s.setOpen}>
        <button
          type="button"
          onClick={() => s.setOpen(true)}
          disabled={s.pending}
          className="flex min-w-0 max-w-[55vw] shrink-0 items-center gap-1.5 rounded-full border border-border bg-muted/40 py-1 pl-1.5 pr-2 text-left transition hover:bg-muted disabled:opacity-60 lg:hidden"
          aria-label={t('switcherMobileTriggerAria')}
        >
          <OrgInitial name={s.displayOrg} />
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{chipLabel}</span>
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        </button>

        <SheetContent side="bottom" className="max-h-[80vh] rounded-t-2xl p-0">
          <SheetHeader className="border-b pb-3">
            <SheetTitle>{t('switcherMobileSheetTitle')}</SheetTitle>
          </SheetHeader>

          <div className="focus-inset flex-1 overflow-y-auto px-2 pb-4">
            {/* 현재 조직 */}
            <div className="flex items-center justify-between px-2 py-2">
              <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                <OrgInitial name={s.displayOrg} />
                {s.displayOrg}
              </span>
              <button
                type="button"
                onClick={() => { window.location.href = '/settings?tab=organization'; }}
                className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                aria-label={t('switcherOrgSettingsAria')}
              >
                <Settings className="h-3.5 w-3.5" />
              </button>
            </div>
            {projects.map((project) => (
              <button
                key={project.projectId}
                type="button"
                disabled={s.pending}
                onClick={() => void s.switchProject(project.projectId)}
                className="flex w-full items-center gap-2 rounded-lg px-4 py-2.5 text-left transition hover:bg-accent disabled:opacity-60"
              >
                <span className="min-w-0 flex-1 truncate text-sm">{project.projectName}</span>
                {project.projectId === s.currentProjectId && (
                  <Check className="h-4 w-4 shrink-0 text-primary" />
                )}
              </button>
            ))}
            <button
              type="button"
              onClick={() => s.setCreateProjectOpen(true)}
              className="flex w-full items-center gap-2 rounded-lg px-4 py-2.5 text-left text-muted-foreground transition hover:bg-accent"
            >
              <Plus className="h-4 w-4 shrink-0" />
              <span className="text-sm">{t('switcherNewProject')}</span>
            </button>

            {/* 다른 조직들 */}
            {s.otherOrgs.map((org) => {
              const orgProjects = s.otherOrgProjects[org.orgId];
              const isLoading = s.loadingOrgIds.has(org.orgId);
              return (
                <div key={org.orgId} className="mt-2 border-t pt-2">
                  <div className="flex items-center gap-1.5 px-2 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    <OrgInitial name={org.orgName} />
                    {org.orgName}
                    {org.role && <span className="text-[9px] font-normal capitalize normal-case opacity-60">{org.role}</span>}
                  </div>
                  {isLoading ? (
                    <div className="flex items-center gap-2 px-4 py-2.5 text-sm text-muted-foreground">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      <span>{tCommon('loading')}</span>
                    </div>
                  ) : orgProjects && orgProjects.length > 0 ? (
                    orgProjects.map((project) => (
                      <button
                        key={project.projectId}
                        type="button"
                        disabled={s.pending}
                        onClick={() => void s.switchOrgAndProject(org.orgId, project.projectId)}
                        className="flex w-full items-center gap-2 rounded-lg px-4 py-2.5 text-left transition hover:bg-accent disabled:opacity-60"
                      >
                        <span className="min-w-0 flex-1 truncate text-sm">{project.projectName}</span>
                      </button>
                    ))
                  ) : (
                    <button
                      type="button"
                      disabled={s.pending}
                      onClick={() => void s.switchOrg(org.orgId)}
                      className="flex w-full items-center gap-2 rounded-lg px-4 py-2.5 text-left text-muted-foreground transition hover:bg-accent disabled:opacity-60"
                    >
                      <span className="text-sm">{t('switcherSwitchToOrg')}</span>
                    </button>
                  )}
                </div>
              );
            })}

            <div className="mt-2 border-t pt-2">
              <button
                type="button"
                onClick={() => s.setCreateOrgOpen(true)}
                className="flex w-full items-center gap-2 rounded-lg px-4 py-2.5 text-left transition hover:bg-accent"
              >
                <Plus className="h-4 w-4 shrink-0" />
                <span className="text-sm">{t('switcherNewOrganization')}</span>
              </button>
            </div>
          </div>
        </SheetContent>
      </Sheet>

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
              <label className="text-sm font-medium" htmlFor="chip-proj-name">
                {t('switcherProjectNameLabel')} <span className="text-destructive">*</span>
              </label>
              <input
                id="chip-proj-name"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                placeholder={t('switcherProjectNamePlaceholder')}
                value={s.newProjectName}
                onChange={(e) => s.setNewProjectName(e.target.value)}
                required
                autoFocus
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="chip-proj-desc">
                {t('switcherDescriptionLabel')} <span className="text-muted-foreground text-xs">{t('switcherOptionalLabel')}</span>
              </label>
              <textarea
                id="chip-proj-desc"
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
