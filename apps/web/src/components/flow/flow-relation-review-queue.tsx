'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { PORT_LINK_KINDS, type PortLinkKind } from './flow-port-linking';
import type { RawReferenceCandidate } from './derive-flow-map';
import { selectUnconfirmedCandidates, buildReviewQueue } from './flow-relation-review';

interface TargetStoryInfo {
  storyNumber: number | null;
  title: string;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'empty' }
  | { kind: 'reviewing'; queue: RawReferenceCandidate[]; index: number; handledCount: number }
  | { kind: 'done'; handledCount: number };

type ItemState = { kind: 'idle' } | { kind: 'submitting' } | { kind: 'error'; message: string };

interface FlowRelationReviewQueueProps {
  storyId: string;
  storyNumber: number;
  /** 이 story의 epic — AC12 "지금 보는 갈래"의 재료(같은 갈래 target 우선 노출). */
  epicId: string | null;
  onClose: () => void;
  /** 해소된 관계 하나가 처리될 때마다 호출 — 지도가 실선을 다시 그리도록 부모에게 알린다. */
  onCandidateResolved?: () => void;
  /** 테스트 전용 — 기본은 `RELATION_REVIEW_QUEUE_CAP`(20). AC12 검증은 상한을 실제로
   * 넘겨야 하므로(#2366 AC9와 같은 규율 — "지금 통과"가 아니라 "초과 상태를 만들어") 값을
   * 주입할 수 있게 둔다. */
  queueCap?: number;
}

/**
 * doc `flow-port-slot-spec` §㉥ · story #2358 — 「확認하기」 훑기 큐. 한 노드(=이 story가
 * source인 후보 전체, `list_candidates_for_source` 스코프)의 relation_kind=null 후보를
 * 연달아 훑는다. §J-2-1 카피 그대로: 종류 3버튼(같은 무게) → 「종류는 모르겠지만 이어진 건
 * 맞습니다」(declare만, 바로 아래·낮은 무게이되 버튼) → 「관계가 아닙니다」·「나중에」.
 * ⛔일괄 확定 없음(#2269) — 답할 때마다 다음 후보가 «같은 자리»에 바로 온다(왕복 1).
 * AC11·12(2026-08-07 착수 시 재측정 후 추가·디디 dev DB 실측 max=17·p90=4·total=1277) —
 * 한 번에 노출하는 묶음은 `queueCap`으로 상한을 두고, 넘으면 지금 훑는 story의 epic과
 * 같은 target을 우선 보인다(기계확신 정렬 재료 자체가 없다 — DB에 confidence 필드 無).
 */
export function FlowRelationReviewQueue({
  storyId, storyNumber, epicId, onClose, onCandidateResolved, queueCap,
}: FlowRelationReviewQueueProps) {
  const t = useTranslations('flow');
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [targetInfo, setTargetInfo] = useState<Record<string, TargetStoryInfo>>({});
  const [itemState, setItemState] = useState<ItemState>({ kind: 'idle' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch(`/api/stories/${storyId}/reference-candidates`).catch(() => null);
      if (cancelled) return;
      if (!res || !res.ok) { setState({ kind: 'error' }); return; }
      const raw = (await res.json().catch(() => null)) as RawReferenceCandidate[] | null;
      if (cancelled) return;
      if (!raw) { setState({ kind: 'error' }); return; }
      const unconfirmed = selectUnconfirmedCandidates(raw);
      if (unconfirmed.length === 0) { setState({ kind: 'empty' }); return; }

      const targetIds = Array.from(new Set(unconfirmed.map((c) => c.target_id)));
      const storiesRes = await fetch(`/api/stories?ids=${targetIds.join(',')}`).catch(() => null);
      if (cancelled) return;
      const storiesJson = storiesRes && storiesRes.ok ? await storiesRes.json().catch(() => null) : null;
      const list = (storiesJson?.data ?? []) as Array<{ id: string; story_number: number | null; title: string; epic_id: string | null }>;
      const infoMap: Record<string, TargetStoryInfo> = {};
      const epicMap: Record<string, string | null> = {};
      for (const s of list) {
        infoMap[s.id] = { storyNumber: s.story_number, title: s.title };
        epicMap[s.id] = s.epic_id;
      }
      if (cancelled) return;
      const queue = buildReviewQueue(raw, epicId, epicMap, queueCap);
      setTargetInfo(infoMap);
      setState({ kind: 'reviewing', queue, index: 0, handledCount: 0 });
    })();
    return () => { cancelled = true; };
  }, [storyId, epicId, queueCap]);

  const advance = (handled: boolean) => {
    setItemState({ kind: 'idle' });
    setState((prev) => {
      if (prev.kind !== 'reviewing') return prev;
      const nextIndex = prev.index + 1;
      const nextHandled = prev.handledCount + (handled ? 1 : 0);
      if (nextIndex >= prev.queue.length) return { kind: 'done', handledCount: nextHandled };
      return { ...prev, index: nextIndex, handledCount: nextHandled };
    });
    if (handled) onCandidateResolved?.();
  };

  // story #2485(#2353/#2357 후속) 그라운딩 그대로 — 이 엔드포인트들의 실패 응답엔 FE가
  // 신뢰해 파싱할 envelope 필드가 없다(backend가 generic HTTP 상태코드만 낸다). 서버
  // 원문을 파싱하는 척하는 대신 고정 폴백 문구를 쓴다(#2485가 걷어낸 그 죽은 분기를
  // 다시 심지 않는다).
  const submit = async (action: () => Promise<Response>, fallbackKey: string, onSuccess: () => void) => {
    setItemState({ kind: 'submitting' });
    const res = await action().catch(() => null);
    if (!res || !res.ok) {
      setItemState({ kind: 'error', message: t(fallbackKey) });
      return;
    }
    onSuccess();
  };

  // 카디르 QA(PR#2900, HIGH) → 디디 BE 원자화(PR#2901) — declare에 relation_kind를 같이
  // 실으면 같은 트랜잭션·커밋 1회로 둘 다 반영된다(하나라도 실패하면 커밋 前이라 아무것도
  // 안 남는다). 이전엔 declare 성공→relation-kind 호출을 별도로 보내 부분실패 時
  // status=declared·relation_kind=NULL 영구 고아가 났다 — 단일 호출로 그 창을 원천 봉쇄.
  const handleDeclareWithKind = (candidate: RawReferenceCandidate, relationKind: PortLinkKind) => {
    void submit(
      () => fetch(`/api/stories/${storyId}/reference-candidates/${candidate.id}/declare`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relation_kind: relationKind }),
      }),
      'portLinkErrorFallback',
      () => advance(true),
    );
  };

  const handleDeclareUnknownKind = (candidate: RawReferenceCandidate) => {
    void submit(
      () => fetch(`/api/stories/${storyId}/reference-candidates/${candidate.id}/declare`, { method: 'POST' }),
      'portLinkErrorFallback',
      () => advance(true),
    );
  };

  const handleReject = (candidate: RawReferenceCandidate) => {
    void submit(
      () => fetch(`/api/stories/${storyId}/reference-candidates/${candidate.id}/reject`, { method: 'POST' }),
      'portRejectErrorFallback',
      () => advance(true),
    );
  };

  const handleLater = () => advance(false);

  if (state.kind === 'loading') return null;
  if (state.kind === 'error') {
    return (
      <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('relationReviewLoadError')}</DialogTitle></DialogHeader>
        </DialogContent>
      </Dialog>
    );
  }
  if (state.kind === 'empty') return null;

  if (state.kind === 'done') {
    return (
      <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('relationReviewDone', { count: state.handledCount })}</DialogTitle>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" onClick={onClose}>{t('portLinkErrorDismiss')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  const candidate = state.queue[state.index];
  const target = targetInfo[candidate.target_id];
  const submitting = itemState.kind === 'submitting';
  // 카디르 QA(PR#2900, LOW①) — target 조회가 실패하면(전체 실패 또는 이 id만 누락) target이
  // undefined다. 그때 "#·"만 뜬 채 declare/reject를 활성으로 두면 «상대가 누군지 모르는
  // 채로 판단»을 허용하는 것 — 종류/기각 응답은 그 판단을 하는 행위라 반드시 막는다.
  // 「나중에」(스킵, 서버 호출 없음)만 열어 둔다.
  const targetUnresolved = !target;

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !submitting) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t('relationReviewPairSentence', { fromNumber: storyNumber, toNumber: target?.storyNumber ?? '·' })}
          </DialogTitle>
          <DialogDescription>{target?.title ?? ''}</DialogDescription>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          {t('relationReviewProgress', { current: state.index + 1, total: state.queue.length })}
        </p>
        {targetUnresolved ? (
          <p role="alert" className="text-xs text-destructive">{t('relationReviewTargetUnresolved')}</p>
        ) : (
          <p className="text-sm font-medium">{t('relationReviewQuestion')}</p>
        )}
        <div className="flex flex-col gap-1.5">
          {PORT_LINK_KINDS.map((kind) => (
            <Button
              key={kind}
              type="button"
              variant="outline"
              disabled={submitting || targetUnresolved}
              onClick={() => handleDeclareWithKind(candidate, kind)}
            >
              {t(`portLinkKind_${kind}`)}
            </Button>
          ))}
          <Button
            type="button"
            variant="ghost"
            disabled={submitting || targetUnresolved}
            onClick={() => handleDeclareUnknownKind(candidate)}
          >
            {t('relationReviewUnknownKind')}
          </Button>
        </div>
        {itemState.kind === 'error' ? (
          <p role="alert" className="text-xs text-destructive">{itemState.message}</p>
        ) : null}
        <DialogFooter className="flex-row justify-between sm:justify-between">
          <Button type="button" variant="ghost" disabled={submitting || targetUnresolved} onClick={() => handleReject(candidate)}>
            {t('relationReviewReject')}
          </Button>
          <Button type="button" variant="ghost" disabled={submitting} onClick={handleLater}>
            {t('relationReviewLater')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
