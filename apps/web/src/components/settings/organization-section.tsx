'use client';

// story 4891 (UI-8 · settings › 조직 · piece ⑤a) — the organization's basic card and its danger card, on the ds parts (SettingsSection · Field · Input · Button · Skeleton). They were inline in the settings page;
// the page keeps the state and the handlers and hands them in, so nothing about WHEN the name saves or WHO may delete changed. Same words (settings · common keys), same keys, same Enter-to-save, same disabled rule.
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ds/button';
import { Field } from '@/components/ds/field';
import { Input } from '@/components/ds/input';
import { Skeleton, SkeletonGroup } from '@/components/ds/skeleton';
import { SettingsSection } from './settings-section';
import { ReadOnlyField } from './settings-parts';
import { orgRoleLabel } from '@/lib/org-member-role';

export interface OrganizationInfo { id: string; name: string; slug: string; plan?: string | null }

export function OrganizationSection({ orgInfo, role, name, onNameChange, onSave, saving, nameError }: {
  /** null while the organization is being read */
  orgInfo: OrganizationInfo | null;
  role: string | null;
  name: string;
  onNameChange: (v: string) => void;
  onSave: () => void;
  saving: boolean;
  nameError: string | null;
}) {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const canRename = role === 'owner' || role === 'admin';
  return (
    <SettingsSection title={t('orgSectionTitle')} description={t('orgSectionDescription')}>
      {orgInfo ? (
        <div className="space-y-4">
          {/* story #3776(1층B) — "이름", settings ns의 기존 profileName 키 재사용. */}
          {canRename ? (
            <Field label={t('profileName')} error={nameError ?? undefined}>
              {(control) => (
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    {...control}
                    className="min-w-0 flex-1"
                    value={name}
                    onChange={(e) => onNameChange(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') onSave(); }}
                  />
                  <Button variant="primary" disabled={!name.trim() || name === orgInfo.name || saving} onClick={onSave}>
                    {/* story #3776(1층B) — "저장", common ns의 기존 save 키 재사용(유나 정정 — 폼 크롬은 common 소관). */}
                    {saving ? tc('saving') : tc('save')}
                  </Button>
                </div>
              )}
            </Field>
          ) : (
            <>
              <ReadOnlyField label={t('profileName')}>{orgInfo.name}</ReadOnlyField>
              {/* the old card drew the rename error under the name in BOTH branches (a failed rename, then a switch to an organization where this person is a plain member, leaves the page's error set) */}
              {nameError ? <p role="alert" className="text-ds-small text-ds-failed">{nameError}</p> : null}
            </>
          )}
          <ReadOnlyField label={t('orgSlugLabel')} mono hint={t('orgSlugImmutable')}>{orgInfo.slug}</ReadOnlyField>
          {orgInfo.plan && <ReadOnlyField label={t('orgPlanLabel')} className="capitalize">{orgInfo.plan}</ReadOnlyField>}
          {role && <ReadOnlyField label={t('orgMyRoleLabel')}>{orgRoleLabel(role, t)}</ReadOnlyField>}
        </div>
      ) : (
        <SkeletonGroup label={tc('loading')} className="space-y-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-10" />
          ))}
        </SkeletonGroup>
      )}
    </SettingsSection>
  );
}

/** the owner's «delete this organization» card — the press only asks the page to open its confirm */
export function OrgDangerSection({ onOpenDelete }: { onOpenDelete: () => void }) {
  const t = useTranslations('settings');
  return (
    <SettingsSection title={<span className="text-ds-failed">{t('dangerZone')}</span>} description={t('orgDeleteWarning')} className="border-ds-failed/40">
      <Button variant="danger" onClick={onOpenDelete}>{t('orgDeleteTitle')}</Button>
    </SettingsSection>
  );
}
