'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { actorRowLabels, memberLookup } from '@/lib/member-display';
import { cn } from '@/lib/utils';
import { pickIGaJosa } from '@/lib/korean-particle';
import { AnchorPin } from './anchor-pin';
import type { MemberRef } from '@/services/canvas';
import type { CommentThread } from '@/services/canvas-comments';
import { Input } from '@/components/ds/input';
import { Button } from '@/components/ds/button';
import { Chip } from '@/components/ds/chip';
import { LAYER } from '@/components/ds/layers';
import { isImeComposing } from '@/lib/ime-composition';

const ROLLUP_LABEL_KEY: Record<CommentThread['rollup'], string> = {
  open: 'rollupOpen',
  resolved: 'rollupResolved',
};

interface CommentThreadCardProps {
  thread: CommentThread;
  memberMap?: Record<string, MemberRef>;
  active?: boolean;
  onSelectPin?: (threadId: string) => void;
  onResolve?: (threadId: string) => void;
  onReply?: (threadId: string, body: string) => void;
  className?: string;
}

/**
 * E-CANVAS C2 §2 — 코멘트 스레드 카드. 공통 코멘트 프리미티브(스토리 코멘트와 동일 인프라)
 * + artifact 앵커 필드만 additive. resolved 스레드는 가라앉음(opacity↓, §3 상태 매트릭스).
 * 수신자별 읽음/응답 추적(PropagationStrip)은 실 BE에 데이터가 없고 §1 감시 리트머스에도
 * 걸려 뺐다(오르테가/PO 승인, 2026-07-10) — resolved/resolved_by 2단계 실 신호만 노출.
 * 결과 연결(resultVersion, C3-S7 source_comment_id closed-loop)은 §1 "주어=결과" —
 * 누가/언제 응답했는지 아닌 "이 피드백이 vN을 낳았다"만 표시(오르테가/유나 승인, 2026-07-11).
 */
export function CommentThreadCard({
  thread, memberMap = {}, active, onSelectPin, onResolve, onReply, className,
}: CommentThreadCardProps) {
  const t = useTranslations('canvas');
  // story #4284 — 이름 없는 구성원 표시(common.memberUnnamed).
  const tc = useTranslations('common');
  // [SID:4286 · 까디르 P1/P4] 작성자 · 처리자 이름 칸의 «—» 폴백 — 이름 빔 = «이름 없는 구성원», 표에 없음 = «알 수 없는 구성원».
  const baseNameOf = (id: string) => memberLookup(memberMap, id, tc)!.label;
  // [SID:4311 PR 3] 댓글 줄 작성자 — 같은 이름 서로 다른 작성자 둘이면 «· ID 앞 8자»(작성자 id마다 한 번). 해결한 사람 문장도 같은 표(한 카드 안에서 같은 사람 = 같은 글자).
  const authorLabels = actorRowLabels(thread.comments.map((c) => ({ id: c.author_id, label: baseNameOf(c.author_id) })));
  const nameOf = (id: string) => authorLabels.get(id) ?? baseNameOf(id);
  const [replyDraft, setReplyDraft] = useState('');
  const resolved = thread.rollup === 'resolved';

  const handleReply = () => {
    const body = replyDraft.trim();
    if (!body) return;
    onReply?.(thread.id, body);
    setReplyDraft('');
  };

  return (
    // 4910 — ds 토큰: 카드 얼굴 = 글 줄 층(LAYER.rowOthers, 칸 위) · 선 = ds-line. 가라앉음(resolved)은 그대로 opacity.
    <div className={cn('rounded-ds-panel border border-ds-line', LAYER.rowOthers, resolved && 'opacity-70', className)}>
      <div className="flex items-center gap-2 border-b border-ds-line px-3 py-2">
        <AnchorPin
          number={thread.pin_number}
          state={resolved ? 'resolved' : 'open'}
          active={active}
          onClick={onSelectPin ? () => onSelectPin(thread.id) : undefined}
        />
        {thread.element_label ? <span className="text-ds-small font-semibold text-ds-ink">{thread.element_label}</span> : null}
        <Chip tone={resolved ? 'done' : 'info'} className="ml-auto">{t(ROLLUP_LABEL_KEY[thread.rollup])}</Chip>
      </div>

      <div className="space-y-2 px-3 py-2.5">
        {thread.comments.map((c) => (
          <div key={c.id}>
            <p className="text-ds-small text-ds-ink-3">
              <strong className="text-ds-ink">{nameOf(c.author_id)}</strong>
            </p>
            <p className="mt-0.5 text-ds-small leading-relaxed text-ds-ink">{c.body}</p>
          </div>
        ))}

        {thread.resultVersion != null ? (
          <p className="text-ds-small font-semibold text-ds-info">{t('resultLinkNote', { version: thread.resultVersion })}</p>
        ) : null}

        {resolved && thread.resolved_by ? (
          <p className="text-ds-small text-ds-ink-3">{t('resolvedByNote', { name: nameOf(thread.resolved_by), josa: pickIGaJosa(nameOf(thread.resolved_by)) })}</p>
        ) : null}

        {!resolved ? (
          <div className="flex items-center gap-1.5 pt-1">
            <Input
              type="text"
              value={replyDraft}
              onChange={(e) => setReplyDraft(e.target.value)}
              // 조합 중의 엔터는 글자 확정 키 — 보내기로 읽으면 반쯤 쓴 답글이 나가고 칸이 비워져 확정된 글자가 다음 답글로 또 나간다(4831 측정 중 발견).
              onKeyDown={(e) => { if (isImeComposing(e)) return; if (e.key === 'Enter') handleReply(); }}
              placeholder={t('replyPlaceholder')}
              aria-label={t('replyPlaceholder')}
              className="min-w-0 flex-1"
            />
            <Button onClick={() => onResolve?.(thread.id)} className="shrink-0">{t('resolveAction')}</Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
