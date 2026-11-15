'use client';

// story 4891 (UI-8 · settings frame + four tabs) — the «프로젝트» pane: the organization's project list (name · description · «현재 프로젝트» tag · edit · delete), the result line, and the «new project» form — drawn with the ds parts.
// The page keeps every piece of state and every request handler (create · update · delete — their bodies are untouched); this file only draws what it is given and hands the presses back, the way `MemberWebhooksSection` does.
// Who may do what is the page's old rule, unchanged: any member sees the list and creates a project (story #4897 — the API allows it); renaming and deleting stay with the admins, and deleting also needs a human (`HumanOnlyAction`, story #2104).
import { useTranslations } from 'next-intl';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { Field } from '@/components/ds/field';
import { Input } from '@/components/ds/input';
import { HumanOnlyAction } from '@/components/ui/human-only-action';
import { SettingsSection } from './settings-section';
import { Tag } from './settings-parts';

export interface ProjectRow {
  id: string;
  name: string;
  description?: string | null;
}

export interface ProjectsSectionProps {
  projects: ProjectRow[];
  currentProjectId: string | null;
  isAdmin: boolean;
  /** the row being edited (null = none) and its two draft fields */
  editingId: string | null;
  editName: string;
  editDescription: string;
  saving: boolean;
  onEditStart: (project: ProjectRow) => void;
  onEditName: (value: string) => void;
  onEditDescription: (value: string) => void;
  onEditSave: () => void;
  onEditCancel: () => void;
  /** the row whose delete is in flight, and the press that asks the page to open the confirmation */
  deletingId: string | null;
  onDeleteAsk: (projectId: string) => void;
  /** the last result (created · updated · deleted · or why not) */
  message: { type: 'success' | 'error'; text: string } | null;
  newName: string;
  newDescription: string;
  creating: boolean;
  onNewName: (value: string) => void;
  onNewDescription: (value: string) => void;
  onCreate: () => void;
}

export function ProjectsSection(p: ProjectsSectionProps) {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  return (
    <SettingsSection title={t('projectManagement')} description={t('projectManagementDescription')} id="projects">
      {p.projects.length > 0 ? (
        <div className="divide-y divide-ds-line overflow-hidden rounded-ds-control border border-ds-line" data-testid="settings-projects-list">
          {p.projects.map((project) => (
            <div key={project.id} className="px-3 py-2.5">
              {p.editingId === project.id ? (
                <div className="flex flex-col gap-2">
                  <Field label={t('projectNamePlaceholder')}>
                    {(c) => <Input {...c} value={p.editName} onChange={(e) => p.onEditName(e.target.value)} />}
                  </Field>
                  <Field label={t('projectDescriptionPlaceholder')}>
                    {(c) => <Input {...c} value={p.editDescription} onChange={(e) => p.onEditDescription(e.target.value)} />}
                  </Field>
                  <div className="flex flex-wrap gap-2">
                    {/* the same two words stand on every row that can be edited: each press is named with its project (the visible word first) */}
                    <Button type="button" variant="primary" aria-label={`${tc('save')} — ${project.name}`} onClick={p.onEditSave} disabled={!p.editName.trim() || p.saving} loading={p.saving}>
                      {tc('save')}
                    </Button>
                    <Button type="button" variant="quiet" aria-label={`${tc('cancel')} — ${project.name}`} onClick={p.onEditCancel}>
                      {tc('cancel')}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-ds-body font-medium text-ds-ink">{project.name}</span>
                      {project.id === p.currentProjectId ? <Tag tone="action">{t('currentProjectBadge')}</Tag> : null}
                    </div>
                    {project.description ? <div className="text-ds-small text-ds-ink-3 [overflow-wrap:anywhere]">{project.description}</div> : null}
                  </div>
                  {p.isAdmin ? (
                    <div className="flex shrink-0 items-center gap-1">
                      {/* the visible word repeats on every row, so each press is named with its project (the visible word first). */}
                      <Button type="button" variant="quiet" aria-label={`${tc('edit')} — ${project.name}`} onClick={() => p.onEditStart(project)}>
                        {tc('edit')}
                      </Button>
                      {/* story #2104 — the API refuses a delete from anything that is not a human (an irreversible action); the button is drawn for an admin and shown only to a human */}
                      <HumanOnlyAction>
                        <Button type="button" variant="danger" aria-label={`${t('deleteProject')} — ${project.name}`} onClick={() => p.onDeleteAsk(project.id)} disabled={p.deletingId === project.id} loading={p.deletingId === project.id}>
                          {t('deleteProject')}
                        </Button>
                      </HumanOnlyAction>
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="rounded-ds-control border border-dashed border-ds-line px-3 py-6 text-ds-body text-ds-ink-3">{t('projectListEmpty')}</p>
      )}

      {/* story #2105 — a result is read out the moment it appears: an error is an alert, a success a status (the ds Banner's own roles); the page clears it before each try, so every try is read again */}
      {p.message ? <Banner tone={p.message.type === 'success' ? 'info' : 'failed'}>{p.message.text}</Banner> : null}

      {/* story #4897 — any member of the organization may create a project (the API has always allowed it: it checks the organization and the plan limit, not the role) */}
      <div className="flex flex-col gap-3 border-t border-ds-line pt-3" data-testid="settings-project-new">
        <Field label={t('projectNamePlaceholder')}>
          {(c) => <Input {...c} value={p.newName} onChange={(e) => p.onNewName(e.target.value)} />}
        </Field>
        <Field label={t('projectDescriptionPlaceholder')}>
          {(c) => <Input {...c} value={p.newDescription} onChange={(e) => p.onNewDescription(e.target.value)} />}
        </Field>
        <div>
          <Button type="button" variant="primary" size="lg" onClick={p.onCreate} disabled={!p.newName.trim() || p.creating} loading={p.creating}>
            {t('createProjectAction')}
          </Button>
        </div>
      </div>
    </SettingsSection>
  );
}
