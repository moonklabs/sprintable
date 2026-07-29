'use client';

import { useMemo, useState } from 'react';
import { Link2, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { findReferenceCandidates, isCandidateRejected, rejectCandidate, type ReferenceCandidate } from '@/lib/reference-candidates';

interface ReferenceSuggestionRowProps {
  messageId: string;
  content: string;
  /** AC1: 보낸 사람 본인의 메시지 바로 아래에서만 묻는다 — 남의 메시지엔 안 뜬다. */
  isMine: boolean;
  /** story #2283/#2582: 해소(number→story, slug→doc) 조회 스코프. 없으면 확인을 시도하지
   * 않는다(스코프 없이 조회하면 다른 프로젝트 결과가 섞일 위험). */
  projectId?: string;
}

type ConfirmState =
  | { status: 'idle' }
  | { status: 'confirming' }
  | { status: 'linked'; referenceId: string }
  | { status: 'undoing'; referenceId: string }
  | { status: 'failed' };

const IDLE: ConfirmState = { status: 'idle' };

async function resolveTarget(
  candidate: ReferenceCandidate,
  projectId: string,
): Promise<{ type: 'story' | 'doc'; id: string } | null> {
  if (candidate.kind === 'number') {
    const params = new URLSearchParams({ project_id: projectId, story_number: candidate.value, limit: '1' });
    const res = await fetch(`/api/stories?${params}`);
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: { id?: string }[] };
    const id = json.data?.[0]?.id;
    return id ? { type: 'story', id } : null;
  }
  const res = await fetch(`/api/docs/preview?q=${encodeURIComponent(candidate.value)}`);
  if (!res.ok) return null;
  const json = (await res.json()) as { data?: { id?: string } };
  const id = json.data?.id;
  return id ? { type: 'doc', id } : null;
}

/**
 * story #2283 — 사람이 채팅에 평문으로 친 `#번호`·`#슬러그`를 「이걸 스토리/문서로 잇겠습니까?」로
 * 한 번 묻는다. ⛔자동 확정 금지(AC2) — 사람이 누른 것만 선다.
 *
 * BE 쓰기 경로(#2582, PO 확定 계약: reference-direct-create-contract-20260728 doc) 착지 후
 * 실제로 잇는다:
 *   ①해소(candidate → target UUID) — number는 `/api/stories?story_number=`, slug는
 *     `/api/docs/preview?q=`(둘 다 이 스토리 이전부터 있던 기존 lookup — 신규 발명 0. story_number
 *     쪽은 BE에 필드가 있었는데 FE repository가 안 실어 나르던 것만 이번에 이었다).
 *   ②`POST /api/references` — 201(신규)/200(이미 있던 것) 둘 다 성공으로 처리, id를 들고
 *     있다가 즉시 취소(`DELETE /api/references/{id}`)를 그 자리에서 걸 수 있게 한다.
 *   ③저장 결과는 응답이 온 뒤에만·그 말 옆에서만 본다 — 성공은 안 보이고(별도 "저장됨" 문구
 *     없음, 그냥 되돌리기 버튼으로 조용히 전환), "저장 중"도 안 보인다(버튼만 잠깐 비활성화).
 *     실패는 종류-무관 한 벌 문구("연결이 저장되지 않았습니다 · 다시 시도") — 스토리든 문서든
 *     같은 말(유나신 #2263 규율).
 */
export function ReferenceSuggestionRow({ messageId, content, isMine, projectId }: ReferenceSuggestionRowProps) {
  const t = useTranslations('chats');
  // AC3 ②: 거절 즉시 이 렌더 인스턴스에서도 사라지도록 로컬 상태로 미러링(localStorage는
  // 다음 마운트/새로고침 시의 진실이고, 지금 이 세션에서 즉시 반영되려면 상태가 필요하다).
  const [locallyDismissed, setLocallyDismissed] = useState<Set<string>>(() => new Set());
  const [confirmStates, setConfirmStates] = useState<Map<string, ConfirmState>>(() => new Map());

  const candidates = useMemo(() => {
    if (!isMine) return [];
    return findReferenceCandidates(content).filter(
      (c) => !isCandidateRejected(messageId, c.raw) && !locallyDismissed.has(c.raw),
    );
  }, [isMine, content, messageId, locallyDismissed]);

  if (candidates.length === 0) return null;

  const setState = (raw: string, state: ConfirmState) => {
    setConfirmStates((prev) => {
      const next = new Map(prev);
      next.set(raw, state);
      return next;
    });
  };

  const handleReject = (raw: string) => {
    rejectCandidate(messageId, raw);
    setLocallyDismissed((prev) => new Set(prev).add(raw));
  };

  const handleConfirm = async (candidate: ReferenceCandidate) => {
    if (!projectId) { setState(candidate.raw, { status: 'failed' }); return; }
    setState(candidate.raw, { status: 'confirming' });
    try {
      const target = await resolveTarget(candidate, projectId);
      if (!target) { setState(candidate.raw, { status: 'failed' }); return; }
      const res = await fetch('/api/references', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_type: 'chat_message',
          source_id: messageId,
          target_type: target.type,
          target_id: target.id,
        }),
      });
      if (!res.ok) { setState(candidate.raw, { status: 'failed' }); return; }
      const created = (await res.json()) as { id?: string };
      if (!created.id) { setState(candidate.raw, { status: 'failed' }); return; }
      setState(candidate.raw, { status: 'linked', referenceId: created.id });
    } catch {
      setState(candidate.raw, { status: 'failed' });
    }
  };

  const handleUndo = async (raw: string, referenceId: string) => {
    setState(raw, { status: 'undoing', referenceId });
    try {
      const res = await fetch(`/api/references/${referenceId}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 204) { setState(raw, { status: 'failed' }); return; }
      setState(raw, IDLE);
    } catch {
      setState(raw, { status: 'failed' });
    }
  };

  const handleRetry = (candidate: ReferenceCandidate) => {
    setState(candidate.raw, IDLE);
  };

  return (
    <div className="mt-1 flex flex-col gap-1">
      {candidates.map((c) => {
        const state = confirmStates.get(c.raw) ?? IDLE;
        return (
          <div
            key={c.raw}
            className="flex items-center gap-2 rounded-md border border-dashed border-border bg-muted/30 px-2.5 py-1.5 text-xs text-muted-foreground"
          >
            <Link2 className="size-3.5 shrink-0" aria-hidden />
            {state.status === 'linked' ? (
              <>
                <span className="flex-1" />
                <button
                  type="button"
                  onClick={() => handleUndo(c.raw, state.referenceId)}
                  className="rounded px-1.5 py-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  {t('referenceCandidateUndo')}
                </button>
              </>
            ) : state.status === 'failed' ? (
              <>
                <span className="flex-1">{t('referenceCandidateLinkFailed')}</span>
                <button
                  type="button"
                  onClick={() => handleRetry(c)}
                  className="rounded px-1.5 py-0.5 font-medium text-primary hover:bg-primary/10"
                >
                  {t('referenceCandidateRetry')}
                </button>
              </>
            ) : (
              <>
                <span className="flex-1">
                  {t(c.kind === 'number' ? 'referenceCandidatePromptStory' : 'referenceCandidatePromptDoc', { token: c.raw })}
                </span>
                <button
                  type="button"
                  disabled={state.status === 'confirming' || state.status === 'undoing'}
                  onClick={() => handleConfirm(c)}
                  className="rounded px-1.5 py-0.5 font-medium text-primary hover:bg-primary/10 disabled:pointer-events-none disabled:opacity-50"
                >
                  {t('referenceCandidateConfirm')}
                </button>
                <button
                  type="button"
                  disabled={state.status === 'confirming' || state.status === 'undoing'}
                  onClick={() => handleReject(c.raw)}
                  aria-label={t('referenceCandidateReject')}
                  className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                >
                  <X className="size-3.5" />
                </button>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
