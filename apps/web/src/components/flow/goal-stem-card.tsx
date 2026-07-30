'use client';

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import type { GoalStem, NextMakerStory } from './derive-next-maker';
import { deriveNextPickCandidates, NEXT_PICK_TOP_COUNT, type NextPickCandidate, type NextPickReasonKey } from './derive-next-pick';
import type { RawReferenceCandidate } from './derive-flow-map';
import { FlowEpicNodes } from './flow-epic-nodes';

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
  onGoalTransitioned: (epicId: string) => void;
}

type PickState =
  | { kind: 'closed' }
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
 * story #2224 후속(2026-07-31) — 줄기(목표) 카드 하나. 접힘=요약 flags+[다음 고르기] 버튼.
 * 펼침=③근거 붙인 후보(NEXT_PICK_TOP_COUNT개 강조+나머지 목록) — 완료 조건은 "화면이 선다"가
 * 아니라 "다음이 실제로 생긴다"(PO)라 [다음으로] 버튼이 실제 PATCH를 쏜다. 조용한(3순위)
 * 목표는 ④[아직 하는 중입니까?] 프롬프트를 같은 자리에 얹는다. ⑤이어짐은 본체가 아니라
 * 펼친 뒤 맨 아래 보조 박스로 붙는다(기존 FlowEpicNodes 그대로 재사용 — 새 캔버스 안 그림).
 */
export function GoalStemCard({
  stem, projectId, backlogStories, recentlyClosedTargetIds, memberMap,
  onSelectStory, onStoryPromoted, onGoalTransitioned,
}: GoalStemCardProps) {
  const t = useTranslations('flow');
  const [expanded, setExpanded] = useState(false);
  const [pickState, setPickState] = useState<PickState>({ kind: 'closed' });
  const [promotingId, setPromotingId] = useState<string | null>(null);
  const [showRest, setShowRest] = useState(false);
  const [quietBusy, setQuietBusy] = useState(false);
  const [quietDismissed, setQuietDismissed] = useState(false);

  const loadCandidates = useCallback(() => {
    setPickState({ kind: 'loading' });
    fetch(`/api/goals/${stem.epicId}/reference-candidates`)
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => [])
      .then((raw: unknown) => {
        const rows: RawReferenceCandidate[] = Array.isArray(raw) ? raw : [];
        const referencedIds = new Set(
          rows.filter((c) => c.relation_kind !== 'explicitly_unrelated').map((c) => c.target_id),
        );
        const candidates = deriveNextPickCandidates(backlogStories, recentlyClosedTargetIds, referencedIds, Date.now());
        setPickState({ kind: 'ready', candidates });
      });
  }, [stem.epicId, backlogStories, recentlyClosedTargetIds]);

  const handleToggle = useCallback(() => {
    const next = !expanded;
    setExpanded(next);
    if (next && pickState.kind === 'closed') loadCandidates();
  }, [expanded, pickState.kind, loadCandidates]);

  const handlePromote = useCallback((storyId: string) => {
    setPromotingId(storyId);
    fetch(`/api/stories/${storyId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'ready-for-dev' }),
    })
      .then((r) => {
        if (r.ok) onStoryPromoted(storyId, stem.epicId);
      })
      .finally(() => setPromotingId(null));
  }, [stem.epicId, onStoryPromoted]);

  const handleGoalTransition = useCallback((status: 'done' | 'archived') => {
    setQuietBusy(true);
    fetch(`/api/goals/${stem.epicId}/transition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    })
      .then((r) => {
        if (r.ok) onGoalTransitioned(stem.epicId);
      })
      .finally(() => setQuietBusy(false));
  }, [stem.epicId, onGoalTransitioned]);

  const accentClass = stem.priority === 'about-to-stall'
    ? 'border-l-amber-500'
    : stem.hasNext ? 'border-l-emerald-500' : 'border-l-border';

  return (
    <div className={`rounded-lg border border-l-[3px] ${accentClass}`}>
      <div className="flex items-center gap-3 px-3 py-2.5">
        <span className="w-40 shrink-0 truncate text-[13px] font-semibold text-foreground">{stem.title}</span>
        <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
          {stem.inProgressCount > 0 && (
            <Flag tone="info" label={t('nextMakerFlagInProgress', { n: stem.inProgressCount })} />
          )}
          {stem.waitingCount > 0 && (
            <Flag tone="neutral" label={t('nextMakerFlagWaiting', { n: stem.waitingCount })} />
          )}
          {stem.priority === 'recently-active' && (
            <Flag tone="brand" label={t('nextMakerFlagRecentlyClosed')} />
          )}
          {stem.hasNext && (
            <Flag tone="brand" label={t('nextMakerFlagHasNext', { n: stem.readyForDevCount })} />
          )}
        </div>
        <button
          type="button"
          onClick={handleToggle}
          className={`shrink-0 rounded-md border px-3 py-1.5 text-xs font-medium transition ${
            expanded ? 'border-border text-foreground' : 'border-primary bg-primary text-primary-foreground'
          }`}
        >
          {t(stem.hasNext ? 'nextMakerOpenAction' : 'nextMakerPickAction')}
        </button>
      </div>

      {expanded && (
        <div className="space-y-3 border-t border-border bg-muted/30 px-3 py-3">
          {stem.priority === 'quiet' && !quietDismissed && (
            <QuietPrompt
              busy={quietBusy}
              onContinue={() => setQuietDismissed(true)}
              onClose={() => handleGoalTransition('done')}
              onArchive={() => handleGoalTransition('archived')}
            />
          )}

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

          {/* ⑤이어짐 — 본체가 아니라 펼친 뒤 맨 아래 보조 박스(PO note ⑤, a920c25f v2).
              기존 FlowEpicNodes를 그대로 재사용 — 새 렌더 경로를 만들지 않는다. */}
          <div className="border-t border-border pt-2">
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
              {t('nextMakerFlowboxHeading', { title: stem.title })}
            </p>
            <FlowEpicNodes projectId={projectId} epicId={stem.epicId} epicTitle={stem.title} onSelectStory={onSelectStory} />
          </div>
        </div>
      )}
    </div>
  );
}

function Flag({ tone, label }: { tone: 'info' | 'neutral' | 'brand' | 'warn'; label: string }) {
  const cls = {
    info: 'border-info/50 text-info',
    neutral: 'border-border text-muted-foreground',
    brand: 'border-primary/50 text-primary font-semibold',
    warn: 'border-amber-500/50 text-amber-600 dark:text-amber-400 font-semibold',
  }[tone];
  return <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${cls}`}>{label}</span>;
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
