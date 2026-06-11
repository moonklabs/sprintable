'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Plus, Sparkles } from 'lucide-react';
import type { Hypothesis, HypothesisDraft } from '@sprintable/core-storage';
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

/**
 * AI 초안 미리보기 카드(S10 §3.9·§7). persist=false 응답을 읽기전용으로 보여주고 휴먼
 * 확인을 받는다 — work-about-work 0(가설문장+지표+측정일 3필드만). "확인하고 추가"가
 * persist=true(proposed row·drafted_by_member_id) 경로. 설익은 자동화로 신뢰를 깨지 않게
 * 항상 휴먼 confirm 게이트(블루프린트 §10-9).
 */
function HypothesisDraftPreview({
  draft,
  confirming,
  onAccept,
  onCancel,
}: {
  draft: HypothesisDraft;
  confirming: boolean;
  onAccept: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations('hypotheses');
  const md = draft.metric_definition;
  const dir = md.direction === 'up' ? t('dirUp') : t('dirDown');

  return (
    <div className="space-y-3 rounded-xl border border-primary/30 bg-primary/5 p-3">
      <div className="flex items-center gap-1.5 text-xs font-medium text-primary">
        <Sparkles className="size-3.5" aria-hidden />
        {t('draftReviewTitle')}
      </div>

      <div className="space-y-2">
        <div className="space-y-0.5">
          <p className="text-[11px] font-medium text-muted-foreground">{t('statementField')}</p>
          <p className="text-sm text-foreground">{draft.statement}</p>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span><span className="font-medium">{t('metricField')}:</span> {md.metric} {dir} {md.target}</span>
          <span><span className="font-medium">{t('measureAfterField')}:</span> {draft.measure_after.slice(0, 10)}</span>
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground">{t('draftNote')}</p>

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={confirming}
          className="rounded-lg px-3 py-1.5 text-sm text-muted-foreground transition hover:text-foreground disabled:opacity-50"
        >
          {t('cancel')}
        </button>
        <button
          type="button"
          onClick={onAccept}
          disabled={confirming}
          className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50"
        >
          {confirming ? t('saving') : t('draftAccept')}
        </button>
      </div>
    </div>
  );
}

export function HypothesesSection({ epicId, projectId }: { epicId: string; projectId: string }) {
  const t = useTranslations('hypotheses');
  const [items, setItems] = useState<Hypothesis[] | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // S10: AI 초안 미리보기(persist=false 응답)·생성 중·확인 중.
  const [draft, setDraft] = useState<HypothesisDraft | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [confirming, setConfirming] = useState(false);

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

  // S10 §3.9: 흐름 부산물에서 AI 초안 생성. persist=false → 미리보기만(active row 0·AC①).
  const handleDraft = useCallback(async () => {
    setDrafting(true);
    setFormOpen(false);
    try {
      const res = await fetch('/api/hypotheses/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, source_type: 'epic', source_id: epicId, persist: false }),
      });
      if (res.ok) {
        const json = await res.json();
        setDraft((json?.data ?? null) as HypothesisDraft | null);
      }
    } finally {
      setDrafting(false);
    }
  }, [epicId, projectId]);

  // 휴먼 확인(AC②): persist=true → status='proposed' row 생성(drafted_by_member_id 기록·AC④).
  // active로 만들지 않는다 — 활성화는 별도 onActivate(휴먼 1스텝).
  const handleAcceptDraft = useCallback(async () => {
    setConfirming(true);
    try {
      const res = await fetch('/api/hypotheses/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, source_type: 'epic', source_id: epicId, persist: true }),
      });
      if (res.ok) { setDraft(null); await load(); }
    } finally {
      setConfirming(false);
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
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-foreground">{t('sectionTitle')}</h2>
        {!formOpen && !draft ? (
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={() => void handleDraft()}
              disabled={drafting}
              className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground transition hover:border-primary hover:text-primary disabled:opacity-50"
            >
              <Sparkles className="size-3.5" />
              {drafting ? t('drafting') : t('draftCta')}
            </button>
            <button
              type="button"
              onClick={() => setFormOpen(true)}
              className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground transition hover:border-primary hover:text-primary"
            >
              <Plus className="size-3.5" />
              {t('add')}
            </button>
          </div>
        ) : null}
      </div>

      {formOpen ? (
        <div className="mt-3">
          <HypothesisForm submitting={submitting} onSubmit={handleCreate} onCancel={() => setFormOpen(false)} />
        </div>
      ) : null}

      {draft ? (
        <div className="mt-3">
          <HypothesisDraftPreview
            draft={draft}
            confirming={confirming}
            onAccept={() => void handleAcceptDraft()}
            onCancel={() => setDraft(null)}
          />
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
