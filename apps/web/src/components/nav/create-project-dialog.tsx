'use client';

import { useTranslations } from 'next-intl';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ProjectAccessPicker } from '@/components/nav/project-access-picker';
import { ProjectFolderField } from '@/components/nav/project-folder-field';
import { ProjectLimitBanner } from '@/components/nav/project-limit-banner';
import { NewProjectMacBlock } from '@/components/nav/new-project-mac-block';
import type { useUnifiedSwitcher } from '@/hooks/use-unified-switcher';

// story 5032 (C2): the «new project» dialog, lifted out of unified-switcher.tsx unchanged so the chat list's «+ 새 채널» opens the SAME dialog (a channel IS a project: one name · the agents that may be called) — one form, one set of rules (plan limit · folder · who may grant).
// `variant="channel"` only changes the words (title · name label); the state and the create call are the switcher hook's (`s`).
export type CreateProjectDialogState = ReturnType<typeof useUnifiedSwitcher>;

export function CreateProjectDialog({ s, variant = 'project', idPrefix = 'unified' }: { s: CreateProjectDialogState; variant?: 'project' | 'channel'; idPrefix?: string }) {
  const t = useTranslations('nav');
  const tCommon = useTranslations('common');
  const channel = variant === 'channel';
  return (
    <>
      <Dialog open={s.createProjectOpen} onOpenChange={s.setCreateProjectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{channel ? t('switcherNewChannelDialogTitle') : t('switcherNewProjectDialogTitle')}</DialogTitle>
          </DialogHeader>
          <NewProjectMacBlock orgId={s.currentOrg?.orgId} />
          <form onSubmit={(e) => { e.preventDefault(); void s.createProject(s.newProjectName, s.newProjectDesc); }} className="space-y-3">
            {/* [SID:4681] (Yuna §K): the plan's project limit — a warning banner at the form's top (in place of the general failure line below) */}
            {s.createProjectLimit && <ProjectLimitBanner key={s.createProjectLimitNonce} limit={s.createProjectLimit.limit} free={s.createProjectLimit.free} />}
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor={`${idPrefix}-proj-name`}>
                {channel ? t('switcherChannelNameLabel') : t('switcherProjectNameLabel')} <span className="text-destructive">*</span>
              </label>
              <Input
                id={`${idPrefix}-proj-name`}
                className="h-auto bg-background dark:bg-background"
                placeholder={t('switcherProjectNamePlaceholder')}
                value={s.newProjectName}
                onChange={(e) => s.setNewProjectName(e.target.value)}
                required
                autoFocus
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor={`${idPrefix}-proj-desc`}>
                {t('switcherDescriptionLabel')} <span className="text-muted-foreground text-xs">{t('switcherOptionalLabel')}</span>
              </label>
              <Textarea
                id={`${idPrefix}-proj-desc`}
                className="min-h-0 bg-background dark:bg-background"
                placeholder={t('switcherProjectDescPlaceholder')}
                rows={3}
                value={s.newProjectDesc}
                onChange={(e) => s.setNewProjectDesc(e.target.value)}
              />
            </div>
            {/* [SID:4681] (D3 · piece ③): the project's folder on this Mac — drawn inside the desktop app only (a browser has no field · AC3);
                above the check list (Yuna §H) */}
            <ProjectFolderField value={s.newProjectFolder} onChange={s.setNewProjectFolder} disabled={s.creating} idPrefix={idPrefix} />
            {/* [SID:4681] (D3 · piece ②): who may work in the new project — the organization's agents, all off to start; the web too (AC3).
                Kadir codex · PO (나): an org member may not grant (the server's rule) — no list, no call */}
            {s.canGrantAccess && <ProjectAccessPicker selected={s.newProjectAgentIds} onChange={s.setNewProjectAgentIds} disabled={s.creating} idPrefix={idPrefix} />}
            {/* story #2468(b) — 실패를 침묵하지 않는다("버튼 무반응"의 정체가 이 자리였다). */}
            {s.createProjectError && (
              <p role="alert" className="text-sm text-destructive">{s.createProjectError}</p>
            )}
            <DialogFooter>
              {/* story #4370 — 보이는 «취소»는 폼 초안을 버린다(✕ · 바깥 · Esc 닫힘은 남긴다). */}
              <DialogClose render={<Button type="button" variant="ghost" disabled={s.creating} onClick={s.clearNewProjectDraft}>{tCommon('cancel')}</Button>} />
              <Button type="submit" disabled={!s.newProjectName.trim() || s.creating}>
                {s.creating ? tCommon('creating') : t('switcherCreateButton')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      {/* [SID:4681]: the project was made but some grants failed — said here (the dialog closed and the switch happened), like the org-switch error above */}
      {s.createProjectNotice && (
        <p role="alert" className="mt-1 px-1 text-xs text-destructive" data-testid="unified-switcher-create-project-notice">{s.createProjectNotice}</p>
      )}
      {/* [SID:4681] ③: the folder could not be kept on this Mac — its own line (Yuna §H: never one sentence with the grants' line) */}
      {s.createProjectFolderNotice && (
        <p role="alert" className="mt-1 px-1 text-xs text-destructive" data-testid="unified-switcher-create-project-folder-notice">{s.createProjectFolderNotice}</p>
      )}
    </>
  );
}
