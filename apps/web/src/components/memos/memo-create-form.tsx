'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { OperatorDropdownSelect } from '@/components/ui/operator-dropdown-select';
import { MemoComposer } from '@/components/memos/memo-composer';
import { MEMO_TEMPLATE_PRESETS, type MemoTemplateId, type MemoDraftState, getMemoTemplatePreset, parseMemoDraft, serializeMemoDraft } from './memo-workspace';

interface Member {
  id: string;
  name: string;
}

interface MemoCreateFormProps {
  initialTitle?: string;
  members: Member[];
  onSubmit: (data: { title: string; content: string; memo_type: string; assigned_to_ids: string[] }) => Promise<boolean> | boolean;
  onCancel: () => void;
  draftStorageKey?: string;
}

const DEFAULT_TEMPLATE: MemoTemplateId = 'blank';

export function MemoCreateForm({ members, onSubmit, onCancel, initialTitle, draftStorageKey }: MemoCreateFormProps) {
  const t = useTranslations('memos');
  const tc = useTranslations('common');
  const draftKeyRef = useRef<string | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [memoType, setMemoType] = useState('memo');
  const [assignedToIds, setAssignedToIds] = useState<string[]>([]);
  const [templateId, setTemplateId] = useState<MemoTemplateId>(DEFAULT_TEMPLATE);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!draftStorageKey || draftKeyRef.current === draftStorageKey) return;
    draftKeyRef.current = draftStorageKey;

    let stored: MemoDraftState | null = null;
    try {
      stored = parseMemoDraft(window.localStorage.getItem(draftStorageKey));
    } catch {
      stored = null;
    }
    if (stored) {
      setTitle(stored.title);
      setContent(stored.content);
      setMemoType(stored.memoType);
      setAssignedToIds(stored.assignedTo ? [stored.assignedTo] : []);
      setTemplateId(stored.templateId);
      return;
    }

    setTitle(initialTitle ?? '');
    setContent('');
    setMemoType('memo');
    setAssignedToIds([]);
    setTemplateId(DEFAULT_TEMPLATE);
  }, [draftStorageKey, initialTitle]);

  useEffect(() => {
    if (!draftStorageKey) return;

    const draft = {
      version: 1 as const,
      title,
      content,
      memoType,
      assignedTo: assignedToIds[0] || null, // Save first assignee for backward compatibility
      templateId,
    };

    try {
      window.localStorage.setItem(draftStorageKey, serializeMemoDraft(draft));
    } catch {
      // ignore storage errors
    }
  }, [assignedToIds, content, draftStorageKey, memoType, templateId, title]);

  const applyTemplate = useCallback((nextTemplateId: MemoTemplateId) => {
    const preset = getMemoTemplatePreset(nextTemplateId);
    setTemplateId(nextTemplateId);
    setMemoType(preset.memoType);

    if (nextTemplateId === DEFAULT_TEMPLATE) {
      setTitle('');
      setContent('');
      return;
    }

    setTitle((current) => current.trim() ? current : t(preset.labelKey));
    setContent(preset.content);
  }, [t]);

  const handleSubmit = async () => {
    if (!content.trim()) return;
    // [DIAG] Block submit if members exist but no assignees selected — surface null propagation bug
    if (members.length > 0 && assignedToIds.length === 0) {
      console.error('[MemoCreateForm] Submit blocked: members available but assigned_to_ids is empty', { memberCount: members.length });
      return;
    }
    setSubmitting(true);
    try {
      const submitted = await onSubmit({
        title: title.trim() || content.slice(0, 60),
        content: content.trim(),
        memo_type: memoType,
        assigned_to_ids: assignedToIds,
      });

      if (submitted && draftStorageKey) {
        try {
          window.localStorage.removeItem(draftStorageKey);
        } catch {
          // ignore storage errors
        }
        setTitle('');
        setContent('');
        setMemoType('memo');
        setAssignedToIds([]);
        setTemplateId(DEFAULT_TEMPLATE);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SectionCard>
      <SectionCardHeader>
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-foreground">{t('createTitle')}</h3>
          <p className="text-xs text-muted-foreground">{t('templateHint')}</p>
        </div>
      </SectionCardHeader>
      <SectionCardBody className="space-y-4">
        <div className="space-y-2">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('templateLabel')}</div>
          <div className="flex flex-wrap gap-2">
            {MEMO_TEMPLATE_PRESETS.map((template) => (
              <button
                key={template.id}
                type="button"
                onClick={() => applyTemplate(template.id)}
                className={`rounded-full border px-3 py-1.5 text-xs font-medium transition ${templateId === template.id ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-muted/50 text-foreground hover:bg-muted'}`}
              >
                {t(template.labelKey)}
              </button>
            ))}
          </div>
        </div>

        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('titlePlaceholder')} />

        <MemoComposer
          value={content}
          onChange={setContent}
          onSubmit={handleSubmit}
          placeholder={t('contentPlaceholder')}
          submitLabel={tc('create')}
          helperText={t('imagePasteHint')}
          rows={7}
          submitting={submitting}
          showSubmitButton={false}
        />

        <div className="grid gap-3 lg:grid-cols-2">
          <OperatorDropdownSelect
            value={memoType}
            onValueChange={setMemoType}
            options={[
              { value: 'memo', label: t('typeMemo') },
              { value: 'task', label: t('typeTask') },
              { value: 'checklist', label: t('typeChecklist') },
              { value: 'decision', label: t('typeDecision') },
              { value: 'request', label: t('typeRequest') },
              { value: 'handoff', label: t('typeHandoff') },
            ]}
          />
          <div className="space-y-2">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('assignees')}</div>
            <div className="max-h-32 space-y-1 overflow-y-auto rounded-md border border-input p-2">
              {members.length === 0 ? (
                <div className="text-xs text-muted-foreground">{t('noMembers')}</div>
              ) : (
                members.map((m) => (
                  <label key={m.id} className="flex items-center gap-2 cursor-pointer hover:bg-muted/50 rounded px-2 py-1">
                    <input
                      type="checkbox"
                      checked={assignedToIds.includes(m.id)}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setAssignedToIds((prev) => [...prev, m.id]);
                        } else {
                          setAssignedToIds((prev) => prev.filter((id) => id !== m.id));
                        }
                      }}
                      className="h-4 w-4"
                    />
                    <span className="text-sm">{m.name}</span>
                  </label>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="rounded-md border border-input px-4 py-2 text-sm text-muted-foreground hover:bg-muted">
            {tc('cancel')}
          </button>
          <button onClick={handleSubmit} disabled={!content.trim() || submitting} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
            {submitting ? t('submitting') : tc('create')}
          </button>
        </div>
      </SectionCardBody>
    </SectionCard>
  );
}
