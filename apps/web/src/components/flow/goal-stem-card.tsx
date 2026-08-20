'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import type { GoalStem, NextMakerStory } from './derive-next-maker';
import { deriveNextPickCandidates, NEXT_PICK_TOP_COUNT, type NextPickCandidate, type NextPickReasonKey } from './derive-next-pick';
import type { RawReferenceCandidate } from './derive-flow-map';
import { FlowEpicNodes } from './flow-epic-nodes';
import { fetchWithAuth } from '@/lib/db/client';
import { GoalOutcomeDialog, type GoalOutcomeSubmission } from '@/components/goals/goal-outcome-dialog';

export interface MemberLite {
  name: string;
  type: string;
}

interface GoalStemCardProps {
  stem: GoalStem;
  projectId: string;
  backlogStories: NextMakerStory[]; // this epic's backlog stories only (already fetched by parent)
  recentlyClosedTargetIds: Set<string>; // next-up target_ids (isRecent only), project-wide — membership check is enough
  memberMap: Record<string, MemberLite>;
  onSelectStory: (storyId: string) => void;
  onStoryPromoted: (storyId: string, epicId: string) => void;
  onPromoteFailed: (storyId: string) => void;
  onGoalTransitioned: (epicId: string) => void;
  /** story #2354 — 순수 통과 prop(FlowMapCanvas 참고). */
  selectedNodeId?: string | null;
  /** story #2224 AC1 후속(2026-07-31, PO 정정 — 「«수단»을 빼면 그 위에 탄 «다른 목적»이
   * 같이 죽는다」) — 갈래 캔버스가 화면의 본체(FlowMultiLaneCanvas)로 옮겨간 뒤, 이 컴포넌트는
   * 좁은 인라인 자리(NextActionsStrip)에서 승격/전환 «동사»만 쓰인다. false면 내장 단일-레인
   * 캔버스(FlowEpicNodes)를 렌더하지 않는다 — 같은 정보를 두 번 그리지 않기 위함. */
  showCanvas?: boolean;
}

type PickState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; candidates: NextPickCandidate[] };

const REASON_LABEL_KEY: Record<NextPickReasonKey, string> = {
  'recently-spawned': 'nextPickReasonSpawned',
  referenced: 'nextPickReasonReferenced',
  owned: 'nextPickReasonOwned',
  'long-waiting': 'nextPickReasonWaiting',
};

/**
 * story #2224 후속(2026-07-31) — 「초점」 잡힌 줄기 하나의 본체. 결함 fix(선생님 "이게 뭔지..")
 * 후속 재구조: 예전엔 이 컴포넌트가 «접힘/펼침»을 스스로 들고 좁은 전체폭 카드로 쌓였는데,
 * PO 판정("갈래가 화면의 몸통이어야 한다·머리:갈래=1:3 이하")에 따라 — 줄기 «선택»은
 * `StemRow`(왼쪽 좁은 열)가 맡고, 이 컴포넌트는 항상 «펼쳐진 채»로 오른쪽 넓은 본문에
 * «하나만» 마운트된다(초점 바뀌면 부모가 key로 통째로 새로 마운트 — pickState/showRest가
 * 초점마다 자연히 리셋). 캔버스가 몸통이라 펼침을 껐다켰다 할 이유가 없어졌다.
 *
 * ③근거 붙은 후보(NEXT_PICK_TOP_COUNT개 강조+나머지 목록) — 완료 조건은 "화면이 선다"가
 * 아니라 "다음이 실제로 생긴다"(PO)라 [다음으로] 버튼이 실제 PATCH를 쏜다. 조용한(3순위)
 * 목표는 ④[아직 하는 중입니까?] 프롬프트를 같은 자리에 얹는다.
 *
 * ①갈래(선·노드)가 이제 «몸통» — 픽 패널은 그 위(작게), 캔버스는 아래(크게, min-h로 지배).
 */
export function GoalStemCard({
  stem, projectId, backlogStories, recentlyClosedTargetIds, memberMap,
  onSelectStory, onStoryPromoted, onPromoteFailed, onGoalTransitioned, selectedNodeId = null, showCanvas = true,
}: GoalStemCardProps) {
  const t = useTranslations('flow');
  const [pickState, setPickState] = useState<PickState>({ kind: 'loading' });
  const [promotingId, setPromotingId] = useState<string | null>(null);
  const [showRest, setShowRest] = useState(false);
  const [quietBusy, setQuietBusy] = useState(false);
  const [quietDismissed, setQuietDismissed] = useState(false);
  // story #2844 — done 전이는 outcome 판정 다이얼로그를 먼저 거친다(archived는 그대로 직행).
  const [outcomeDialogOpen, setOutcomeDialogOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPickState({ kind: 'loading' });
    fetchWithAuth(`/api/goals/${stem.epicId}/reference-candidates`)
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => [])
      .then((raw: unknown) => {
        if (cancelled) return;
        const rows: RawReferenceCandidate[] = Array.isArray(raw) ? raw : [];
        const referencedIds = new Set(
          rows.filter((c) => c.relation_kind !== 'explicitly_unrelated').map((c) => c.target_id),
        );
        const candidates = deriveNextPickCandidates(backlogStories, recentlyClosedTargetIds, referencedIds, Date.now());
        setPickState({ kind: 'ready', candidates });
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- backlogStories/recentlyClosedTargetIds identity churns every parent render; epicId is the real trigger.
  }, [stem.epicId]);

  const handlePromote = useCallback((storyId: string) => {
    setPromotingId(storyId);
    fetch(`/api/stories/${storyId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'ready-for-dev' }),
    })
      .then((r) => {
        // 까심 QA REQUEST_CHANGES(2026-07-31) — 실패를 조용히 삼키던 것을 고친다. 로컬 상태는
        // 여전히 서버 200 후에만 반영한다(낙관적 업데이트 없음, 그대로 유지) — 실패면 그냥
        // 사용자에게 «말하기»만 한다.
        if (r.ok) onStoryPromoted(storyId, stem.epicId);
        else onPromoteFailed(storyId);
      })
      .catch(() => onPromoteFailed(storyId))
      .finally(() => setPromotingId(null));
  }, [stem.epicId, onStoryPromoted, onPromoteFailed]);

  const handleGoalTransition = useCallback((status: 'done' | 'archived', outcome?: GoalOutcomeSubmission) => {
    setQuietBusy(true);
    // story #2844 — 'skipped'는 outcome_status를 아예 안 보낸다(#2843 계약: 미제공=unmeasured 자동
    // 마킹, 전이 자체는 안 막힘). hit/miss/unmeasurable만 outcome_status+outcome_result를 싣는다.
    const body = outcome && !('skipped' in outcome)
      ? { status, outcome_status: outcome.outcome_status, outcome_result: outcome.outcome_result }
      : { status };
    fetch(`/api/goals/${stem.epicId}/transition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then((r) => {
        if (r.ok) onGoalTransitioned(stem.epicId);
      })
      .finally(() => {
        setQuietBusy(false);
        setOutcomeDialogOpen(false);
      });
  }, [stem.epicId, onGoalTransitioned]);

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-foreground">{stem.title}</h2>
        {/* PO 판정(2026-07-31) — 「한 번에 다 정하지 않아도 됩니다」는 첫 줄(헤드라인)이 아니라
            여기(다음 고르기가 실제로 열린 자리)로 내린다. 설명 셋이 헤드라인에 몰려 "화면이
            변명으로 시작"하던 것을 이 한 줄만 남기고 나머지 둘은 다른 자리로 흩었다. */}
        <p className="mt-0.5 text-xs text-muted-foreground">{t('nextMakerSubline')}</p>
      </div>

      {stem.priority === 'quiet' && !quietDismissed && (
        <QuietPrompt
          busy={quietBusy}
          onContinue={() => setQuietDismissed(true)}
          onClose={() => setOutcomeDialogOpen(true)}
          onArchive={() => handleGoalTransition('archived')}
        />
      )}

      {outcomeDialogOpen ? (
        <GoalOutcomeDialog
          goalTitle={stem.title}
          submitting={quietBusy}
          onSubmit={(result) => handleGoalTransition('done', result)}
          onCancel={() => setOutcomeDialogOpen(false)}
        />
      ) : null}

      {backlogStories.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('nextMakerNoCandidates')}</p>
      ) : pickState.kind === 'loading' ? (
        <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          {t('nextMakerPickLoading')}
        </div>
      ) : pickState.kind === 'ready' ? (
        <NextPickList
          candidates={pickState.candidates}
          memberMap={memberMap}
          promotingId={promotingId}
          showRest={showRest}
          onShowRest={() => setShowRest(true)}
          onPromote={handlePromote}
          onSelectStory={onSelectStory}
          t={t}
        />
      ) : null}

      {/* ①갈래(선·노드)가 이 화면의 몸통(PO 판정 2026-07-31, 선생님 "이게 뭔지.." 후속) —
          픽 패널이 «위/작게», 캔버스가 «아래/크게»다. min-h로 시각 지배력을 명시로 준다.
          단 이제 캔버스의 진짜 몸통은 FlowMultiLaneCanvas(story #2224 AC1)라, 이 컴포넌트가
          좁은 인라인 자리(NextActionsStrip)에 설 때는 showCanvas=false로 이 블록을 끈다 —
          같은 레인을 두 번 그리지 않는다. */}
      {showCanvas && (
        <div className="min-h-[520px] rounded-lg border border-border">
          <FlowEpicNodes projectId={projectId} epicId={stem.epicId} epicTitle={stem.title} onSelectStory={onSelectStory} selectedNodeId={selectedNodeId} memberMap={memberMap} />
        </div>
      )}
    </div>
  );
}

function QuietPrompt({
  busy, onContinue, onClose, onArchive,
}: { busy: boolean; onContinue: () => void; onClose: () => void; onArchive: () => void }) {
  const t = useTranslations('flow');
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed border-border px-3 py-2">
      <span className="text-xs text-muted-foreground">{t('nextMakerQuietPrompt')}</span>
      <div className="ml-auto flex gap-1.5">
        <button type="button" disabled={busy} onClick={onContinue} className="rounded border border-border px-2 py-1 text-[11px] font-medium disabled:opacity-50">
          {t('nextMakerQuietContinue')}
        </button>
        <button type="button" disabled={busy} onClick={onClose} className="rounded border border-border px-2 py-1 text-[11px] font-medium disabled:opacity-50">
          {t('nextMakerQuietClose')}
        </button>
        <button type="button" disabled={busy} onClick={onArchive} className="rounded border border-border px-2 py-1 text-[11px] font-medium disabled:opacity-50">
          {t('nextMakerQuietArchive')}
        </button>
      </div>
    </div>
  );
}

function NextPickList({
  candidates, memberMap, promotingId, showRest, onShowRest, onPromote, onSelectStory, t,
}: {
  candidates: NextPickCandidate[];
  memberMap: Record<string, MemberLite>;
  promotingId: string | null;
  showRest: boolean;
  onShowRest: () => void;
  onPromote: (storyId: string) => void;
  onSelectStory: (storyId: string) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const top = candidates.slice(0, NEXT_PICK_TOP_COUNT);
  const rest = candidates.slice(NEXT_PICK_TOP_COUNT);

  return (
    <div className="space-y-1.5">
      <p className="text-[11px] text-muted-foreground">
        {t('nextMakerPickHint', { n: candidates.length })}
      </p>
      {top.map((c) => (
        <PickRow key={c.story.id} candidate={c} isTop memberMap={memberMap} promoting={promotingId === c.story.id} onPromote={onPromote} onSelectStory={onSelectStory} t={t} />
      ))}
      {rest.length > 0 && !showRest && (
        <button type="button" onClick={onShowRest} className="w-full rounded-md border border-dashed border-border py-1.5 text-[11px] text-muted-foreground">
          {t('nextMakerPickRest', { n: rest.length })}
        </button>
      )}
      {showRest && rest.map((c) => (
        <PickRow key={c.story.id} candidate={c} isTop={false} memberMap={memberMap} promoting={promotingId === c.story.id} onPromote={onPromote} onSelectStory={onSelectStory} t={t} />
      ))}
    </div>
  );
}

function PickRow({
  candidate, isTop, memberMap, promoting, onPromote, onSelectStory, t,
}: {
  candidate: NextPickCandidate;
  isTop: boolean;
  memberMap: Record<string, MemberLite>;
  promoting: boolean;
  onPromote: (storyId: string) => void;
  onSelectStory: (storyId: string) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const ownerName = candidate.story.assigneeId ? memberMap[candidate.story.assigneeId]?.name : null;
  return (
    <div className={`flex items-center gap-2.5 rounded-md border border-l-2 bg-card px-2.5 py-2 ${isTop ? 'border-l-primary' : 'border-l-border'}`}>
      <button type="button" onClick={() => onSelectStory(candidate.story.id)} className="min-w-0 flex-1 text-left">
        <div className="truncate text-xs text-foreground">
          #{candidate.story.storyNumber} {candidate.story.title}
        </div>
        <div className="mt-0.5 flex flex-wrap gap-2 text-[10.5px] text-muted-foreground">
          {candidate.reasons.map((r) => (
            <span key={r} className={r === 'owned' ? '' : 'font-medium text-primary'}>
              {r === 'owned' && ownerName
                ? t('nextPickReasonOwnedNamed', { name: ownerName })
                : t(REASON_LABEL_KEY[r], { n: candidate.waitingDays })}
            </span>
          ))}
        </div>
      </button>
      <button
        type="button"
        disabled={promoting}
        onClick={() => onPromote(candidate.story.id)}
        className="shrink-0 rounded-md border border-primary bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground disabled:opacity-50"
      >
        {promoting ? <Loader2 className="size-3 animate-spin" aria-hidden="true" /> : t('nextMakerPromoteAction')}
      </button>
    </div>
  );
}
