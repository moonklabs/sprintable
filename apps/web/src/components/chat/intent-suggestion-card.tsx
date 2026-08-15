'use client';

import { useMemo, useState } from 'react';
import { ArrowUpCircle, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  detectApprovalIntent, detectCompletionIntent, detectAssignmentIntent,
  extractEntityRefs, firstRefOfType, type IntentSuggestionKind, type EntityRef,
} from '@/lib/intent-suggestion-classifier';
import { isSuggestionDismissed, dismissSuggestion } from '@/lib/intent-suggestion-dismissal';
import type { EntityStatusFetchState } from '@/components/chat/entity-status-labels';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';

interface IntentSuggestionCardProps {
  messageId: string;
  content: string;
  /** AC1과 동형(reference-suggestion-row.tsx) — 보낸 사람 본인의 메시지 아래에서만 묻는다. */
  isMine: boolean;
  /** chat-view.tsx가 대화당 1회 배치조회한 「타입:id → 상태」 캐시 — B2(#2669)와 동일 재사용,
   * 이 카드 전용의 추가 fetch를 만들지 않는다(승인/완료 두 축 모두 이 캐시만으로 판정). */
  entityStatusByKey?: Record<string, EntityStatusFetchState>;
}

type Suggestion = { kind: IntentSuggestionKind; ref: EntityRef; label: string; endpoint: string; body: Record<string, unknown> };

type ActionState = { status: 'idle' } | { status: 'submitting' } | { status: 'done' } | { status: 'failed' };
const IDLE: ActionState = { status: 'idle' };

function rawStatusOf(entityStatusByKey: Record<string, EntityStatusFetchState> | undefined, ref: EntityRef): string | null {
  // use-entity-status-batch.ts는 키를 `${type}:${id}`.toLowerCase()로 저장한다 — 여기서도
  // 똑같이 낮춰야 조회가 맞는다(안 맞추면 항상 "아직 모름"으로 새는 조용한 미스매치).
  const state = entityStatusByKey?.[`${ref.type}:${ref.id}`.toLowerCase()];
  return state?.kind === 'resolved' ? state.raw : null;
}

/** story #2638 — 승인/완료/배정 3축을 우선순위 순으로 딱 하나만 고른다(과잉 카드 방지,
 * classifier.ts의 "메시지당 최대 1건" 절제와 동형). 순수 함수 — 테스트가 직접 부른다. */
export function computeSuggestion(
  content: string, entityStatusByKey: Record<string, EntityStatusFetchState> | undefined,
): Suggestion | null {
  const refs = extractEntityRefs(content);

  if (detectApprovalIntent(content)) {
    const ref = firstRefOfType(refs, ['doc']);
    if (ref && rawStatusOf(entityStatusByKey, ref) === 'draft') {
      return {
        kind: 'approval', ref, label: 'intentSuggestionApprovalCta',
        endpoint: `/api/docs/${ref.id}/transition`, body: { status: 'pending' },
      };
    }
  }
  if (detectCompletionIntent(content)) {
    const ref = firstRefOfType(refs, ['story', 'task']);
    const status = ref ? rawStatusOf(entityStatusByKey, ref) : null;
    if (ref && status !== null && status !== 'done') {
      return {
        kind: 'completion', ref, label: 'intentSuggestionCompletionCta',
        endpoint: ref.type === 'story' ? `/api/stories/${ref.id}` : `/api/tasks/${ref.id}`,
        body: { status: 'done' },
      };
    }
  }
  if (detectAssignmentIntent(content)) {
    const ref = firstRefOfType(refs, ['story', 'task']);
    if (ref) {
      return {
        kind: 'assignment', ref, label: 'intentSuggestionAssignmentCta',
        endpoint: ref.type === 'story' ? `/api/stories/${ref.id}` : `/api/tasks/${ref.id}`,
        // handleConfirm이 currentTeamMemberId로 치환해 보낸다 — 여기 body는 순수 판정용
        // 자리표시(실제 요청에 안 실림).
        body: {},
      };
    }
  }
  return null;
}

export function IntentSuggestionCard({ messageId, content, isMine, entityStatusByKey }: IntentSuggestionCardProps) {
  const t = useTranslations('chats');
  const { currentTeamMemberId } = useDashboardContext();
  const [dismissedLocally, setDismissedLocally] = useState(false);
  const [state, setState] = useState<ActionState>(IDLE);

  const suggestion = useMemo(
    () => (isMine ? computeSuggestion(content, entityStatusByKey) : null),
    [isMine, content, entityStatusByKey],
  );

  if (!suggestion) return null;
  if (dismissedLocally || isSuggestionDismissed(messageId, suggestion.kind)) return null;
  if (state.status === 'done') return null;

  const handleDismiss = () => {
    dismissSuggestion(messageId, suggestion.kind);
    setDismissedLocally(true);
  };

  const handleConfirm = async () => {
    setState({ status: 'submitting' });
    try {
      let body = suggestion.body;
      if (suggestion.kind === 'assignment') {
        if (!currentTeamMemberId) { setState({ status: 'failed' }); return; }
        body = { assignee_id: currentTeamMemberId };
      }
      const res = await fetch(suggestion.endpoint, {
        method: suggestion.kind === 'approval' ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) { setState({ status: 'failed' }); return; }
      setState({ status: 'done' });
    } catch {
      setState({ status: 'failed' });
    }
  };

  return (
    <div className="mt-1 flex items-center gap-2 rounded-md border border-dashed border-primary/40 bg-primary/5 px-2.5 py-1.5 text-xs text-foreground">
      <ArrowUpCircle className="size-3.5 shrink-0 text-primary" aria-hidden />
      <span className="flex-1">{t(suggestion.label)}</span>
      {state.status === 'failed' && <span className="text-destructive">{t('intentSuggestionFailed')}</span>}
      <button
        type="button"
        onClick={() => void handleConfirm()}
        disabled={state.status === 'submitting'}
        className="rounded border border-primary/40 px-1.5 py-0.5 font-medium text-primary hover:bg-primary/10 disabled:opacity-60"
      >
        {state.status === 'submitting' ? t('intentSuggestionSubmitting') : t('intentSuggestionConfirm')}
      </button>
      <button type="button" onClick={handleDismiss} className="shrink-0 text-muted-foreground hover:text-foreground" aria-label={t('intentSuggestionDismiss')}>
        <X className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}
