'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Plus } from 'lucide-react';
import type { Hypothesis } from '@sprintable/core-storage';
import { HypothesisRow, type HypothesisRowActions } from './hypothesis-row';
import { HypothesisVerdictCard } from './hypothesis-verdict-card';
import { HypothesisForm, type HypothesisFormValue } from './hypothesis-form';

/**
 * Epic-detail Hypotheses section (E1-S8 §4.1). The first human-facing surface that
 * pulls hypotheses out of the hidden epic/story outcome columns into a 1st-class entity.
 * Mounts below the dispatch panel, above the description; replaces the legacy inline
 * outcome-intent UI (AC5).
 *
 * Data path: GET /api/hypotheses (thin proxy → {data} envelope), so we read json.data.
 */
const isVerdict = (h: Hypothesis) => h.status === 'verified' || h.status === 'falsified';

export function HypothesesSection({ epicId, projectId }: { epicId: string; projectId: string }) {
  const t = useTranslations('hypotheses');
  const [items, setItems] = useState<Hypothesis[] | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/hypotheses?project_id=${projectId}&epic_id=${epicId}`, { cache: 'no-store' });
      if (!res.ok) { setItems([]); return; }
      const json = await res.json();
      setItems((json?.data ?? []) as Hypothesis[]);
    } catch {
      setItems([]);
    }
  }, [epicId, projectId]);

  useEffect(() => { void load(); }, [load]);

  const handleCreate = useCallback(async (value: HypothesisFormValue) => {
    setSubmitting(true);
    try {
      const res = await fetch('/api/hypotheses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: projectId,
          epic_ids: [epicId],
          statement: value.statement.trim(),
          metric_definition: value.metric_definition,
          measure_after: new Date(value.measure_after).toISOString(),
        }),
      });
      if (res.ok) { setFormOpen(false); await load(); }
    } finally {
      setSubmitting(false);
    }
  }, [epicId, projectId, load]);

  const actions: HypothesisRowActions = {
    // 초안 확인 = 상태 전이 아님 (PO §12.2): PATCH로 draft_metadata.confirmed=true 기록.
    onConfirmDraft: async (h) => {
      const meta = { ...(h.draft_metadata ?? {}), confirmed: true };
      await fetch(`/api/hypotheses/${h.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draft_metadata: meta }),
      });
      await load();
    },
    // 활성화(proposed→active)만 transition·휴먼 전용.
    onActivate: async (h) => {
      await fetch(`/api/hypotheses/${h.id}/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'active' }),
      });
      await load();
    },
    // kill = destructive·확정 1스텝.
    onKill: async (h) => {
      if (!window.confirm(t('killConfirm'))) return;
      await fetch(`/api/hypotheses/${h.id}/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'killed' }),
      });
      await load();
    },
    onLinkStory: (h) => {
      // Story picker는 별도 affordance(§6.5 story 패널 picker와 공유) — 후속 배선.
      void h;
    },
  };

  // 대표 가설(첫 primary) 상단·verdict 우선 노출.
  const sorted = items ? [...items] : [];

  return (
    <section aria-label={t('sectionTitle')} className="rounded-xl border border-border bg-muted/20 p-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">{t('sectionTitle')}</h2>
        {!formOpen ? (
          <button
            type="button"
            onClick={() => setFormOpen(true)}
            className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground transition hover:border-primary hover:text-primary"
          >
            <Plus className="size-3.5" />
            {t('add')}
          </button>
        ) : null}
      </div>

      {formOpen ? (
        <div className="mt-3">
          <HypothesisForm submitting={submitting} onSubmit={handleCreate} onCancel={() => setFormOpen(false)} />
        </div>
      ) : null}

      <div className="mt-3 space-y-2">
        {items === null ? (
          <p className="text-xs text-muted-foreground">…</p>
        ) : sorted.length === 0 ? (
          !formOpen ? <p className="py-4 text-center text-sm text-muted-foreground">{t('empty')}</p> : null
        ) : (
          sorted.map((h) =>
            isVerdict(h) ? (
              <HypothesisVerdictCard key={h.id} hypothesis={h} />
            ) : (
              <HypothesisRow key={h.id} hypothesis={h} actions={actions} />
            ),
          )
        )}
      </div>
    </section>
  );
}
