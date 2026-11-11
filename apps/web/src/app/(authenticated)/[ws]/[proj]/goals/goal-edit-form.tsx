'use client';

import { useCallback, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useJsonFieldDraft } from '@/hooks/use-json-field-draft';
import type { Goal, GoalEditDraft, GoalPriority } from './goal-model';

// story #4888(UI-5 목표 화면) — goals-client.tsx에서 옮김(동작 무변경): 상세 열의 «편집»이 같은 폼을 쓴다.
// ─── Epic Edit Form ───────────────────────────────────────────────────────────

export interface GoalEditFormProps {
  epic: Goal;
  onSaved: (epic: Goal) => void;
  onCancel: () => void;
}

export function GoalEditForm({ epic, onSaved, onCancel }: GoalEditFormProps) {
  const t = useTranslations('goals');
  // story #4370(유나 판정 (가)) — 설명(여러 줄)이 든 폼이라 폼 전체가 목표별 초안 하나 · 서버 값이 처음 값(같아지면 초안 없음) ·
  // 저장 성공과 «취소»에서만 지운다.
  const serverForm = useMemo<GoalEditDraft>(() => ({
    title: epic.title,
    description: epic.description ?? '',
    priority: epic.priority,
    targetDate: epic.target_date?.slice(0, 10) ?? '',
    targetSp: epic.target_sp !== undefined ? String(epic.target_sp) : '',
  }), [epic.title, epic.description, epic.priority, epic.target_date, epic.target_sp]);
  const [form, setForm, clearFormDraft] = useJsonFieldDraft<GoalEditDraft>(
    { surface: 'goal-edit', targetId: epic.id, field: 'form' }, serverForm,
  );
  const { title, description, priority, targetDate, targetSp } = form;
  const setTitle = (v: string) => setForm({ ...form, title: v });
  const setDescription = (v: string) => setForm({ ...form, description: v });
  const setPriority = (v: GoalPriority) => setForm({ ...form, priority: v });
  const setTargetDate = (v: string) => setForm({ ...form, targetDate: v });
  const setTargetSp = (v: string) => setForm({ ...form, targetSp: v });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    setSubmitting(true);
    setError(null);

    try {
      const body: Record<string, unknown> = {
        title: title.trim(),
        description: description.trim() || undefined,
        priority,
        // RC#2: status 제외 — generic PATCH서 봉인(BE #1651 422)·전용 transition endpoint 전용.
      };
      if (targetDate) body.target_date = targetDate;
      if (targetSp) body.target_sp = Number(targetSp);

      const res = await fetch(`/api/goals/${epic.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) throw new Error('Failed to update epic');

      const { data } = await res.json() as { data: Goal };
      clearFormDraft();
      onSaved({ ...data, stories: epic.stories });
    } catch {
      setError(t('updateError'));
    } finally {
      setSubmitting(false);
    }
  }, [title, description, priority, targetDate, targetSp, epic.id, epic.stories, onSaved, t, clearFormDraft]);

  return (
    <form onSubmit={(e) => { void handleSubmit(e); }} className="space-y-4">
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">{t('fieldTitle')}</label>
        <Input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">{t('fieldDescription')}</label>
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          className="resize-none"
        />
      </div>

      {/* RC#2: status는 편집 폼서 제거 — 전용 POST /epics/{id}/transition(상세 헤더 transition 컨트롤·⓶)·일반 PATCH서 봉인(BE #1651·hypothesis/story 선례 동형). 편집=title/desc/priority/target만. */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">{t('fieldPriority')}</label>
        <Select
          value={priority}
          onChange={(e) => setPriority(e.target.value as GoalPriority)}
        >
          <option value="critical">{t('priorityCritical')}</option>
          <option value="high">{t('priorityHigh')}</option>
          <option value="medium">{t('priorityMedium')}</option>
          <option value="low">{t('priorityLow')}</option>
        </Select>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">{t('fieldTargetDate')}</label>
          <Input
            type="date"
            value={targetDate}
            onChange={(e) => setTargetDate(e.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">{t('fieldTargetSp')}</label>
          <Input
            type="number"
            min="0"
            value={targetSp}
            onChange={(e) => setTargetSp(e.target.value)}
            placeholder="0"
          />
        </div>
      </div>

      {error ? <p className="text-xs text-destructive" role="alert" aria-live="assertive" aria-atomic="true">{error}</p> : null}

      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => { clearFormDraft(); onCancel(); }}>
          {t('cancel')}
        </Button>
        <Button type="submit" size="sm" disabled={submitting || !title.trim()}>
          {submitting ? '...' : t('saveChanges')}
        </Button>
      </div>
    </form>
  );
}
