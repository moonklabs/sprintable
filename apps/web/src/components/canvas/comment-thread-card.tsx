'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { AnchorPin } from './anchor-pin';
import type { MemberRef } from '@/services/canvas';
import type { CommentThread } from '@/services/canvas-comments';

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
 */
export function CommentThreadCard({
  thread, memberMap = {}, active, onSelectPin, onResolve, onReply, className,
}: CommentThreadCardProps) {
  const t = useTranslations('canvas');
  const [replyDraft, setReplyDraft] = useState('');
  const resolved = thread.rollup === 'resolved';
  const rollupTone = resolved ? 'text-success bg-success/10' : 'text-info bg-info/10';

  const handleReply = () => {
    const body = replyDraft.trim();
    if (!body) return;
    onReply?.(thread.id, body);
    setReplyDraft('');
  };

  return (
    <div className={cn('rounded-xl border border-border bg-card shadow-sm', resolved && 'opacity-70', className)}>
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <AnchorPin
          number={thread.pin_number}
          state={resolved ? 'resolved' : 'open'}
          active={active}
          onClick={onSelectPin ? () => onSelectPin(thread.id) : undefined}
        />
        {thread.element_label ? <span className="text-xs font-semibold text-foreground">{thread.element_label}</span> : null}
        <span className={cn('ml-auto rounded px-1.5 py-0.5 text-[9px] font-bold', rollupTone)}>
          {t(ROLLUP_LABEL_KEY[thread.rollup])}
        </span>
      </div>

      <div className="space-y-2 px-3 py-2.5">
        {thread.comments.map((c) => (
          <div key={c.id}>
            <p className="text-[11px] text-muted-foreground">
              <strong className="text-foreground">{memberMap[c.author_id]?.name ?? '—'}</strong>
            </p>
            <p className="mt-0.5 text-xs leading-relaxed text-foreground">{c.body}</p>
          </div>
        ))}

        {resolved && thread.resolved_by ? (
          <p className="text-[10px] text-muted-foreground/80">{t('resolvedByNote', { name: memberMap[thread.resolved_by]?.name ?? '—' })}</p>
        ) : null}

        {!resolved ? (
          <div className="flex items-center gap-1.5 pt-1">
            <input
              type="text"
              value={replyDraft}
              onChange={(e) => setReplyDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleReply(); }}
              placeholder={t('replyPlaceholder')}
              className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-[11px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/40"
            />
            <button
              type="button"
              onClick={() => onResolve?.(thread.id)}
              className="shrink-0 rounded-md border border-border px-2 py-1 text-[10px] font-semibold text-muted-foreground hover:bg-muted"
            >
              {t('resolveAction')}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
