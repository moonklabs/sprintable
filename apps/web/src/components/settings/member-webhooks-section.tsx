'use client';

// story 4891 (UI-8 · settings › 프로젝트 접근 · piece ⑤c) — «팀원 webhook» card: it was inline in the settings page (7519c3ea: each human member of the project has a webhook address row + its status + [저장]); it moves out as a component on ds parts
// (SettingsSection · Input · Button · Tag). The page keeps the state and the save handler and hands them in, so WHEN and WHAT is saved did not change.
import { Webhook } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ds/button';
import { Input } from '@/components/ds/input';
import { RowName } from '@/components/shared/row-name';
import { SettingsSection } from './settings-section';
import { Tag } from './settings-parts';

export interface MemberWebhook { member_id: string; url: string; is_active: boolean }

export function MemberWebhooksSection({ members, webhooks, editing, errors, savingId, rowLabels, onEdit, onSave }: {
  /** the project's human members (id only is needed) */
  members: { id: string }[];
  webhooks: MemberWebhook[];
  /** the draft of each row's address (a row not in here shows its saved address) */
  editing: Record<string, string>;
  errors: Record<string, string>;
  savingId: string | null;
  rowLabels: Map<string, string>;
  onEdit: (memberId: string, value: string) => void;
  onSave: (memberId: string) => void;
}) {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  return (
    <SettingsSection title={t('webhooks')} description={t('webhookDescription')}>
      <div className="space-y-2">
        {members.map((member, index) => {
          // 휴먼 webhook도 canonical webhook_configs(member_id) 기준 — 에이전트와 통일.
          const config = webhooks.find((w) => w.member_id === member.id);
          const draft = editing[member.id] ?? config?.url ?? '';
          const status: 'active' | 'inactive' | 'empty' = !config?.url ? 'empty' : config.is_active ? 'active' : 'inactive';
          const err = errors[member.id];
          return (
            <div key={member.id} className="rounded-ds-control border border-ds-line bg-ds-surface-sunk px-3 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <RowName className="flex-1 text-ds-body font-medium text-ds-ink" label={rowLabels.get(member.id)} id={member.id} />
                <Tag tone={status === 'active' ? 'done' : 'neutral'}>
                  <Webhook className="size-3" aria-hidden />
                  {status === 'active' ? t('webhookStatusActive') : status === 'inactive' ? t('webhookStatusInactive') : t('webhookStatusEmpty')}
                </Tag>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Input
                  type="url"
                  value={draft}
                  onChange={(e) => onEdit(member.id, e.target.value)}
                  placeholder={t('webhookUrlPlaceholder')}
                  className="min-w-0 flex-1 font-mono"
                  aria-label={`${t('webhooks')} — ${rowLabels.get(member.id) ?? member.id}`}
                />
                <Button variant="primary" onClick={() => onSave(member.id)} disabled={savingId === member.id} aria-label={t('orgMemberRowActionAriaLabel', { n: index + 1, label: tc('save') })}>
                  {savingId === member.id ? '...' : tc('save')}
                </Button>
              </div>
              {err ? <p role="alert" aria-live="assertive" aria-atomic="true" className="mt-1 text-ds-small text-ds-failed">{err}</p> : null}
            </div>
          );
        })}
      </div>
    </SettingsSection>
  );
}
