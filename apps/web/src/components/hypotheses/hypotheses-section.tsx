'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Plus, Sparkles } from 'lucide-react';
import type { Hypothesis, HypothesisDraft } from '@sprintable/core-storage';
import { HypothesisRow, type HypothesisRowActions } from './hypothesis-row';
import { HypothesisVerdictCard } from './hypothesis-verdict-card';
import { HypothesisForm, type HypothesisFormValue } from './hypothesis-form';
import { HypothesisGateBadge } from './hypothesis-gate-badge';
import type { GateItem } from '@/components/kanban/types';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';

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
  // S24: gate approval 축 — hypGatesMap(per-hyp gate·work_item_type=hypothesis) + 멤버 이름맵.
  const [hypGatesMap, setHypGatesMap] = useState<Record<string, GateItem>>({});
  const [memberNames, setMemberNames] = useState<Record<string, string>>({});
  const { currentTeamMemberId } = useDashboardContext();

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/hypotheses?project_id=${projectId}&epic_id=${epicId}`, { cache: 'no-store' });
      if (!res.ok) { setItems([]); return; }
      const json = await res.json();
      const arr = (json?.data ?? []) as Hypothesis[];
      setItems(arr);
      // S24 QA LOW② fix: per-hyp N fetch → status-batch(GateInbox식·pending+rejected status-only 2 fetch→클라 work_item_type='hypothesis' 필터·map). confirmed는 hyp payload(confirmed_by) 파생이라 gate 조회 불요.
      const [pendingGates, rejectedGates, membersJson] = await Promise.all([
        fetch('/api/gates?status=pending').then((r) => (r.ok ? (r.json() as Promise<GateItem[]>) : [])).catch(() => []),
        fetch('/api/gates?status=rejected').then((r) => (r.ok ? (r.json() as Promise<GateItem[]>) : [])).catch(() => []),
        fetch('/api/team-members').then((r) => (r.ok ? r.json() : { data: [] })).catch(() => ({ data: [] })),
      ]);
      const gmap: Record<string, GateItem> = {};
      // pending 우선·rejected는 pending 없을 때만(한 hyp에 둘 다면 진행중 pending이 우세).
      for (const g of [...rejectedGates, ...pendingGates]) {
        if (g.work_item_type === 'hypothesis') gmap[g.work_item_id] = g;
      }
      setHypGatesMap(gmap);
      const names: Record<string, string> = {};
      for (const m of (membersJson as { data?: { id: string; name: string }[] }).data ?? []) names[m.id] = m.name;
      setMemberNames(names);
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
          sorted.map((h) => (
            <div key={h.id} className="space-y-2">
              {/* S24 ⓑ gate approval 축(상단 띠) — outcome 축(아래 row/verdict)과 2축 분리 */}
              <HypothesisGateBadge
                hypothesis={h}
                gate={hypGatesMap[h.id]}
                resolveName={(id) => memberNames[id] ?? id.slice(0, 6)}
                resolverId={currentTeamMemberId ?? ''}
                onResolved={() => void load()}
              />
              {isVerdict(h) ? (
                <HypothesisVerdictCard hypothesis={h} />
              ) : (
                <HypothesisRow hypothesis={h} actions={actions} />
              )}
            </div>
          ))
        )}
      </div>
    </section>
  );
}
