'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Link2, Plus, Search, X } from 'lucide-react';
import type { Hypothesis } from '@sprintable/core-storage';
import { HypothesisStatusBadge } from './hypothesis-status-badge';
import { HypothesisGateBadge } from './hypothesis-gate-badge';
import type { GateItem } from '@/components/kanban/types';

/**
 * Story-detail panel "linked hypotheses" surface (E1-S8c / S9 fold · blueprint §6.5).
 *
 * Replaces the legacy inline outcome-intent input. A story can only **link/unlink**
 * existing hypotheses — never create one (AC①: creation lives on the epic detail / MCP).
 * Linking defaults link_type=supports (AC②). Hypotheses owned by a different epic than
 * the story are still linkable, but flagged with a cross-epic warning (AC③).
 *
 * Data path: GET /api/hypotheses (thin proxy → {data} envelope), so we read json.data.
 */
const LINK_TYPE_DEFAULT = 'supports';

export function StoryHypothesesSection({
  storyId,
  epicId,
  projectId,
}: {
  storyId: string;
  epicId: string | null;
  projectId: string;
}) {
  const t = useTranslations('hypotheses');
  const [linked, setLinked] = useState<Hypothesis[] | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [candidates, setCandidates] = useState<Hypothesis[] | null>(null);
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  // S24 follow-up: 연결 칩 compact gate indicator용 hypGatesMap(status-batch·pending/rejected).
  const [hypGatesMap, setHypGatesMap] = useState<Record<string, GateItem>>({});

  // story.epic_id에 속하지 않은 가설 = 다른 에픽 소속(AC③ 경고 대상). epic 미지정 story는 판정 보류.
  const isCrossEpic = useCallback(
    (h: Hypothesis) => epicId != null && !h.epic_ids.includes(epicId),
    [epicId],
  );

  const loadLinked = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/hypotheses?project_id=${projectId}&story_id=${storyId}`,
        { cache: 'no-store' },
      );
      if (!res.ok) { setLinked([]); return; }
      const json = await res.json();
      setLinked((json?.data ?? []) as Hypothesis[]);
      // S24 follow-up: gate status-batch(pending+rejected→hypothesis 필터→map)·confirmed는 칩서 생략이라 불요.
      const [pg, rg] = await Promise.all([
        fetch('/api/gates?status=pending').then((r) => (r.ok ? (r.json() as Promise<GateItem[]>) : [])).catch(() => []),
        fetch('/api/gates?status=rejected').then((r) => (r.ok ? (r.json() as Promise<GateItem[]>) : [])).catch(() => []),
      ]);
      const gmap: Record<string, GateItem> = {};
      for (const g of [...rg, ...pg]) if (g.work_item_type === 'hypothesis') gmap[g.work_item_id] = g;
      setHypGatesMap(gmap);
    } catch {
      setLinked([]);
    }
  }, [projectId, storyId]);

  useEffect(() => { void loadLinked(); }, [loadLinked]);

  const loadCandidates = useCallback(async () => {
    setCandidates(null);
    try {
      const res = await fetch(`/api/hypotheses?project_id=${projectId}`, { cache: 'no-store' });
      if (!res.ok) { setCandidates([]); return; }
      const json = await res.json();
      const all = (json?.data ?? []) as Hypothesis[];
      // 이미 이 story에 연결된 가설은 후보에서 제외.
      setCandidates(all.filter((h) => !h.story_ids.includes(storyId)));
    } catch {
      setCandidates([]);
    }
  }, [projectId, storyId]);

  const openPicker = useCallback(() => {
    setPickerOpen(true);
    setQuery('');
    void loadCandidates();
  }, [loadCandidates]);

  const linkHypothesis = useCallback(async (h: Hypothesis) => {
    setBusyId(h.id);
    try {
      const res = await fetch(`/api/hypotheses/${h.id}/links`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ story_ids: [storyId], link_type: LINK_TYPE_DEFAULT }),
      });
      if (res.ok) {
        await loadLinked();
        setCandidates((prev) => (prev ? prev.filter((c) => c.id !== h.id) : prev));
      }
    } finally {
      setBusyId(null);
    }
  }, [storyId, loadLinked]);

  const unlinkHypothesis = useCallback(async (h: Hypothesis) => {
    setBusyId(h.id);
    try {
      const res = await fetch(`/api/hypotheses/${h.id}/links`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ story_ids: [storyId] }),
      });
      if (res.ok) await loadLinked();
    } finally {
      setBusyId(null);
    }
  }, [storyId, loadLinked]);

  const filteredCandidates = (candidates ?? []).filter((h) =>
    query.trim() ? h.statement.toLowerCase().includes(query.trim().toLowerCase()) : true,
  );

  return (
    <section aria-label={t('linkedTitle')} className="space-y-2 rounded-xl border border-border bg-muted/20 p-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">{t('linkedTitle')}</h3>
        {!pickerOpen ? (
          <button
            type="button"
            onClick={openPicker}
            className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground transition hover:border-primary hover:text-primary"
          >
            <Plus className="size-3.5" />
            {t('linkHypothesis')}
          </button>
        ) : null}
      </div>

      {/* 연결된 가설 read-only chips */}
      {linked === null ? (
        <p className="text-xs text-muted-foreground">…</p>
      ) : linked.length === 0 ? (
        !pickerOpen ? <p className="py-2 text-xs text-muted-foreground">{t('noLinked')}</p> : null
      ) : (
        <ul className="space-y-1.5">
          {linked.map((h) => (
            <li
              key={h.id}
              className="flex items-center gap-2 rounded-lg border border-border bg-background px-2.5 py-1.5"
            >
              <Link2 className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-xs text-foreground" title={h.statement}>
                {h.statement}
              </span>
              {isCrossEpic(h) ? (
                <span
                  className="inline-flex shrink-0 items-center gap-1 text-[11px] text-warning"
                  title={t('crossEpicHint')}
                >
                  <AlertTriangle className="size-3" aria-hidden />
                  {t('crossEpic')}
                </span>
              ) : null}
              {/* S24 follow-up: gate approval compact indicator(pending/rejected만·title 툴팁) */}
              <HypothesisGateBadge hypothesis={h} gate={hypGatesMap[h.id]} compact />
              <HypothesisStatusBadge status={h.status} className="shrink-0" />
              <button
                type="button"
                onClick={() => void unlinkHypothesis(h)}
                disabled={busyId === h.id}
                aria-label={t('unlink')}
                title={t('unlink')}
                className="shrink-0 rounded p-0.5 text-muted-foreground transition hover:bg-accent hover:text-destructive disabled:opacity-50"
              >
                <X className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* 가설 연결 picker (기존 가설 link 전용 — 생성 affordance 없음·AC①) */}
      {pickerOpen ? (
        <div className="space-y-2 rounded-lg border border-border bg-background p-2">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-muted-foreground">{t('pickerTitle')}</p>
            <button
              type="button"
              onClick={() => setPickerOpen(false)}
              aria-label={t('cancel')}
              className="rounded p-0.5 text-muted-foreground transition hover:bg-accent hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </div>
          <div className="flex items-center gap-1.5 rounded-md border border-border px-2">
            <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('pickerSearch')}
              className="w-full bg-transparent py-1.5 text-xs focus:outline-none"
            />
          </div>
          {/* story에선 가설을 생성하지 않는다 — 생성은 에픽 상세/MCP 경로(AC①). */}
          <p className="text-[11px] text-muted-foreground">{t('createElsewhereHint')}</p>
          {candidates === null ? (
            <p className="px-1 py-2 text-xs text-muted-foreground">…</p>
          ) : filteredCandidates.length === 0 ? (
            <p className="px-1 py-2 text-xs text-muted-foreground">{t('pickerEmpty')}</p>
          ) : (
            <ul className="max-h-48 space-y-1 overflow-y-auto">
              {filteredCandidates.map((h) => (
                <li key={h.id}>
                  <button
                    type="button"
                    onClick={() => void linkHypothesis(h)}
                    disabled={busyId === h.id}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition hover:bg-muted disabled:opacity-50"
                  >
                    <span className="min-w-0 flex-1 truncate text-xs text-foreground" title={h.statement}>
                      {h.statement}
                    </span>
                    {isCrossEpic(h) ? (
                      <span
                        className="inline-flex shrink-0 items-center gap-1 text-[11px] text-warning"
                        title={t('crossEpicHint')}
                      >
                        <AlertTriangle className="size-3" aria-hidden />
                        {t('crossEpic')}
                      </span>
                    ) : null}
                    <HypothesisStatusBadge status={h.status} className="shrink-0" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}
