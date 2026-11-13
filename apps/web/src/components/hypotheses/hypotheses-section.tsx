'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Plus, Sparkles } from 'lucide-react';
import { Button } from '@/components/ds/button';
import { cn } from '@/lib/utils';
import { HYPOTHESES_FACE } from './hypotheses-face';
import type { Hypothesis, HypothesisDraft } from '@sprintable/core-storage';
import { HypothesisRow, type HypothesisRowActions } from './hypothesis-row';
import { HypothesisVerdictCard } from './hypothesis-verdict-card';
import { HypothesisForm, type HypothesisFormValue } from './hypothesis-form';
import { HypothesisGateBadge } from './hypothesis-gate-badge';
import { HypothesisResolveDialog, type HypothesisResolveResult } from './hypothesis-resolve-dialog';
import { StoryPickerDialog } from '@/components/canvas/story-picker-dialog';
import type { GateItem } from '@/components/kanban/types';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { useOrgSyncVersion } from '@/lib/project-context-client';
import { actorRowLabels, memberLookup } from '@/lib/member-display';

import { fetchWithAuth } from '@/lib/db/client';
import { ORG_NAMES_URL } from '@/hooks/use-member-name-fallback';

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
  const tc = useTranslations('common');
  const md = draft.metric_definition;
  const dir = md.direction === 'up' ? t('dirUp') : t('dirDown');

  return (
    // 4909 AC3 (가설 칸 1단계) — the preview is the AI-marked face of the ds (info tone) inside the card; the two buttons are ds Buttons (the same texts, the same handlers).
    <div className="space-y-3 rounded-ds-control border border-ds-line bg-ds-info-soft p-3">
      <div className="flex items-center gap-1.5 text-ds-small font-semibold text-ds-info">
        <Sparkles className="size-3.5" aria-hidden />
        {t('draftReviewTitle')}
      </div>

      <div className="space-y-2">
        <div className="space-y-0.5">
          <p className="text-ds-small font-medium text-ds-ink-3">{t('statementField')}</p>
          <p className="text-ds-body text-ds-ink">{draft.statement}</p>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-ds-small text-ds-ink-2">
          <span><span className="font-medium">{t('metricField')}:</span> {md.metric} {dir} {md.target}</span>
          <span><span className="font-medium">{t('measureAfterField')}:</span> {draft.measure_after.slice(0, 10)}</span>
        </div>
      </div>

      <p className="text-ds-small text-ds-ink-3">{t('draftNote')}</p>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="quiet" onClick={onCancel} disabled={confirming}>
          {t('cancel')}
        </Button>
        <Button type="button" variant="primary" onClick={onAccept} disabled={confirming}>
          {confirming ? tc('saving') : t('draftAccept')}
        </Button>
      </div>
    </div>
  );
}

export function HypothesesSection({ epicId, projectId }: { epicId: string; projectId: string }) {
  const t = useTranslations('hypotheses');
  const tc = useTranslations('common');
  const [items, setItems] = useState<Hypothesis[] | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // S10: AI 초안 미리보기(persist=false 응답)·생성 중·확인 중.
  const [draft, setDraft] = useState<HypothesisDraft | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // 4909 (마) — 행 메뉴 «스토리 연결»: 어느 가설에 스토리를 이을지(대화상자 열림) · 연결 요청 중 · 실패 표시.
  const [linkTarget, setLinkTarget] = useState<Hypothesis | null>(null);
  const [linking, setLinking] = useState(false);
  const [linkFailed, setLinkFailed] = useState(false);
  // S24: gate approval 축 — hypGatesMap(per-hyp gate·work_item_type=hypothesis) + 멤버 이름맵.
  const [hypGatesMap, setHypGatesMap] = useState<Record<string, GateItem>>({});
  const [memberNames, setMemberNames] = useState<Record<string, string>>({});
  // [SID:4286] 이름 표를 다 불러왔는지 — 가설 목록이 먼저 그려져 결론 카드가 표보다 먼저 이름을 찾을 수 있다.
  const [memberNamesLoaded, setMemberNamesLoaded] = useState(false);
  const { currentTeamMemberId } = useDashboardContext();
  // story #2036 — measuring 가설을 달성/반증으로 닫는 다이얼로그 상태.
  const [resolving, setResolving] = useState<{ hypothesis: Hypothesis; target: 'verified' | 'falsified' } | null>(null);
  const [resolveSubmitting, setResolveSubmitting] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetchWithAuth(`/api/hypotheses?project_id=${projectId}&epic_id=${epicId}`, { cache: 'no-store' });
      if (!res.ok) { setItems([]); return; }
      const json = await res.json();
      const arr = (json?.data ?? []) as Hypothesis[];
      setItems(arr);
      // S24 QA LOW② fix: per-hyp N fetch → status-batch(GateInbox식·pending+rejected status-only 2 fetch→클라 work_item_type='hypothesis' 필터·map). confirmed는 hyp payload(confirmed_by) 파생이라 gate 조회 불요.
      const [pendingGates, rejectedGates, membersJson] = await Promise.all([
        fetchWithAuth('/api/gates?status=pending').then((r) => (r.ok ? (r.json() as Promise<GateItem[]>) : [])).catch(() => []),
        fetchWithAuth('/api/gates?status=rejected').then((r) => (r.ok ? (r.json() as Promise<GateItem[]>) : [])).catch(() => []),
        // [SID:4300] 이름만 쓰는 표 — 비활성 에이전트도 «목록이 거른 것»이라 비활성까지 싣는 조직 원천(떠난 사람은 BE 4303 대기).
        fetchWithAuth(ORG_NAMES_URL).then((r) => (r.ok ? r.json() : { data: [] })).catch(() => ({ data: [] })),
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
      setMemberNamesLoaded(true);
    } catch {
      setItems([]);
      setMemberNamesLoaded(true);
    }
  }, [epicId, projectId]);

  // story #2545(카디르 라이브 재QA 5단계) — org 불일치 자동교정(switch-org) 성공 直後 재요청
  // 되게 orgSyncVersion을 얹는다(다른 opt-in 컴포넌트와 동일 패턴).
  // [SID:4286] 구성원 id 조각(앞 6자)을 이름 칸에 싣지 않는다 — 표에 없음 → «알 수 없는 구성원» · 불러오는 중 → 빈 칸.
  const baseMemberName = (id: string): string => memberLookup(memberNames, id, tc, { loaded: memberNamesLoaded })?.label ?? '';
  // [SID:4311 PR 3] 가설 행의 담당(@) — 같은 이름 서로 다른 담당 둘이면 «· ID 앞 8자»(담당 id마다 한 번). 같은 칸의 결재 문장도 같은 표(같은 사람 = 같은 글자).
  const ownerLabels = actorRowLabels((items ?? []).map((h) => ({ id: h.owner_member_id, label: h.owner_member_id ? baseMemberName(h.owner_member_id) : null })));
  const resolveMemberName = (id: string): string => ownerLabels.get(id) ?? baseMemberName(id);
  const orgSyncVersion = useOrgSyncVersion();
  useEffect(() => { void load(); }, [load, orgSyncVersion]);

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

  // 휴먼 확인(AC②): status='proposed' row 생성 — active로 만들지 않는다(활성화는 별도 onActivate, 휴먼 1스텝).
  // 4909 (나) — 저장하는 것은 «지금 화면에 미리 보인 그 초안»이다. 예전엔 여기서 /draft를 persist:true로 «다시» 불러 서버가 새 초안을 만들었다
  // (문장은 LLM이라 매번 다르고 측정일도 그 시각 기준) — 사람이 읽고 «확인»한 것과 저장된 것이 달랐다. 이제 미리본 값을 그대로 기존 생성 API로 보낸다.
  const handleAcceptDraft = useCallback(async () => {
    if (!draft) return;
    setConfirming(true);
    try {
      const res = await fetch('/api/hypotheses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: projectId,
          epic_ids: [epicId],
          statement: draft.statement,
          metric_definition: draft.metric_definition,
          measure_after: new Date(draft.measure_after).toISOString(),
          status: 'proposed',
          source_type: 'epic',
          source_id: epicId,
          draft_metadata: { source_snapshot: draft.source_snapshot },
        }),
      });
      if (res.ok) { setDraft(null); await load(); }
    } finally {
      setConfirming(false);
    }
  }, [draft, epicId, projectId, load]);

  // 4909 (마) — 고른 스토리를 그 가설에 잇는다: 스토리 쪽 «연결된 가설» 패널과 같은 요청(POST /api/hypotheses/{id}/links · link_type=supports).
  const handleLinkStory = useCallback(async (storyId: string | null) => {
    const target = linkTarget;
    if (!target || !storyId || linking) return;
    setLinking(true);
    try {
      const res = await fetch(`/api/hypotheses/${target.id}/links`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ story_ids: [storyId], link_type: 'supports' }),
      });
      if (res.ok) { setLinkTarget(null); await load(); } else { setLinkTarget(null); setLinkFailed(true); }
    } catch {
      setLinkTarget(null);
      setLinkFailed(true);
    } finally {
      setLinking(false);
    }
  }, [linkTarget, linking, load]);

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
    // story #2053 — active→measuring. 서버 실측: 이 전이엔 measure_after/지표정의 요건이
    // 없다(transition_hypothesis에 active→measuring 전용 가드 없음, is_valid_transition
    // 통과 후 바로 status만 갱신) — 그냥 시작되면 되므로 확인 다이얼로그 없이 1스텝.
    onStartMeasuring: async (h) => {
      await fetch(`/api/hypotheses/${h.id}/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'measuring' }),
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
    // 4909 (마) — 죽어 있던 항목(눌러도 아무 일 없음)을 이미 있는 스토리 고르기 대화상자 + 이미 있는 연결 API에 배선한다(새 부품 · 새 API 0).
    onLinkStory: (h) => { setLinkFailed(false); setLinkTarget(h); },
    // story #2036 — 다이얼로그를 여는 것까지만. 실제 transition은 handleResolveSubmit.
    onResolve: (h, target) => setResolving({ hypothesis: h, target }),
  };

  // story #2036 AC2/AC3: outcome_result는 transition endpoint가 통째로 덮어쓰므로(병합 아님)
  // 기존 metric_definition 값을 그대로 실어 채점 카드(target/direction) 표시를 보존하고,
  // reason(근거)을 함께 적재한다. AC4: 서버 cron 채점기는 `status IN ('active','measuring')`인
  // 가설만 조회하므로(hypothesis_scorer.py) 사람이 한 번 verified/falsified로 닫으면 그 즉시
  // 채점 대상에서 빠져 자동 채점이 재덮어쓰기할 수 없다 — measure_after 도래 직후의 클릭↔cron
  // 경합만 "먼저 전이한 쪽이 승리"로 남는다.
  // PO 리뷰(2026-07-20): closed_by/closed_by_member_id는 "누가 닫았는가"를 결정하는 신뢰축
  // 필드라 클라이언트가 자칭해선 안 된다 — API를 직접 호출하면 에이전트가 닫은 걸 human으로
  // 위장할 수 있는 구멍이었다. 서버(hypotheses.py의 인증된 caller)가 채워 넣도록 넘기고,
  // FE는 이 필드를 아예 보내지 않는다(계약을 명확히 하기 위해 값 자체를 생략).
  const handleResolveSubmit = useCallback(async (result: HypothesisResolveResult) => {
    if (!resolving) return;
    setResolveSubmitting(true);
    try {
      const { hypothesis: h } = resolving;
      // 유나 가디언 리뷰: 다이얼로그 내 불일치 배너로 판정을 전환할 수 있으므로 열 때의
      // target이 아니라 결과가 실어온 target(사용자가 최종 선택한 판정)을 그대로 쓴다.
      const target = result.target;
      const md = h.metric_definition;
      const res = await fetch(`/api/hypotheses/${h.id}/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: target,
          outcome_result: {
            metric: md?.metric ?? null,
            target: md?.target ?? null,
            direction: md?.direction ?? null,
            actual: result.actual,
            scored_at: new Date().toISOString(),
            reason: result.reason,
          },
        }),
      });
      if (res.ok) { setResolving(null); await load(); }
    } finally {
      setResolveSubmitting(false);
    }
  }, [resolving, load]);

  // 대표 가설(첫 primary) 상단·verdict 우선 노출.
  const sorted = items ? [...items] : [];

  return (
    // 4909 AC3 (가설 칸 1단계) — the card's face is the content layer (HYPOTHESES_FACE = LAYER.panel: one step above the page, +.030 light / +.036 dark — the old `bg-muted/20` card measured −.018 / −.004 and did not separate at all).
    <section aria-label={t('sectionTitle')} data-testid="hypotheses-section" className={cn('rounded-ds-control border border-ds-line p-3', HYPOTHESES_FACE)}>
      {/* story 4906 (customer lap ⑨) — the title + two buttons did not fit the 360px goal-detail card in English («Hypotheses» · «Review draft» · «Add hypothesis»): the buttons group was shrink-0 on a
          no-wrap row and ran past the card's right edge (button right 1091 · card 1059 at a 1100 window). The row and the group now WRAP — beside the title when they fit, under it when they do not. */}
      <div className="flex flex-wrap items-center justify-between gap-2" data-testid="hypotheses-head">
        <h2 className="flex items-center gap-2 text-ds-card-title font-semibold text-ds-ink">
          {t('sectionTitle')}
          {items !== null && items.length > 0 ? <span className="font-mono text-ds-mono-md font-normal text-ds-ink-3" data-testid="hypotheses-count">{items.length}</span> : null}
        </h2>
        {!formOpen && !draft ? (
          <div className="flex min-w-0 flex-wrap items-center gap-1.5" data-testid="hypotheses-head-actions">
            <Button type="button" variant="secondary" onClick={() => void handleDraft()} disabled={drafting} iconStart={<Sparkles className="size-3.5" aria-hidden />}>
              {drafting ? t('drafting') : t('draftCta')}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setFormOpen(true)} iconStart={<Plus className="size-3.5" aria-hidden />}>
              {t('add')}
            </Button>
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

      {linkFailed ? (
        <p role="alert" data-testid="hypothesis-link-failed" className="mt-3 rounded-ds-control border border-ds-failed bg-ds-failed-soft px-3 py-2 text-ds-small text-ds-ink">
          {t('linkStoryFailed')}
        </p>
      ) : null}

      <div className="mt-3 space-y-2">
        {items === null ? (
          <p className="text-ds-small text-ds-ink-3">…</p>
        ) : sorted.length === 0 ? (
          !formOpen ? <p className="py-4 text-center text-ds-small text-ds-ink-3">{t('empty')}</p> : null
        ) : (
          sorted.map((h) => (
            <div key={h.id} className="space-y-2">
              {/* S24 ⓑ gate approval 축(상단 띠) — outcome 축(아래 row/verdict)과 2축 분리 */}
              <HypothesisGateBadge
                hypothesis={h}
                gate={hypGatesMap[h.id]}
                resolveName={resolveMemberName}
                resolverId={currentTeamMemberId ?? ''}
                onResolved={() => void load()}
              />
              {isVerdict(h) ? (
                <HypothesisVerdictCard hypothesis={h} resolveName={resolveMemberName} />
              ) : (
                <HypothesisRow hypothesis={h} actions={actions} resolveName={resolveMemberName} />
              )}
            </div>
          ))
        )}
      </div>

      <StoryPickerDialog
        open={linkTarget !== null}
        onOpenChange={(next) => { if (!next) setLinkTarget(null); }}
        projectId={projectId}
        onSelect={(storyId) => void handleLinkStory(storyId)}
      />

      {resolving ? (
        <HypothesisResolveDialog
          hypothesis={resolving.hypothesis}
          target={resolving.target}
          submitting={resolveSubmitting}
          onSubmit={(result) => void handleResolveSubmit(result)}
          onCancel={() => setResolving(null)}
        />
      ) : null}
    </section>
  );
}
