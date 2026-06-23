'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ShieldCheck, GitPullRequest, AlertTriangle, CheckCircle2, ChevronRight } from 'lucide-react';
import { minutesSince, type MyActions, type Priority, type QueueItem, type AttentionItem } from './types';

// 우선순위 좌border(색=신호): danger/warn만 색·info는 중립(canonical §4 alert만 색).
const PRIORITY_BORDER: Record<Priority, string> = {
  danger: 'border-l-destructive',
  warn: 'border-l-warning',
  info: 'border-l-border',
};

function QueueRow({ item }: { item: QueueItem }) {
  const t = useTranslations('dashboard');
  const ctx = item.context as { gate_id?: string; story_id?: string; kind?: string; status?: string };
  if (item.type === 'gate_approval') {
    // 승인은 우발 mutation 방지 위해 게이트 인박스로 1클릭 네비게이션(전체 맥락서 결재).
    return (
      <Link
        href="/inbox?tab=gates"
        className={`flex items-center gap-2 rounded-lg border border-l-2 border-border bg-card p-2.5 text-xs transition hover:border-muted-foreground/30 ${PRIORITY_BORDER[item.priority]}`}
      >
        <ShieldCheck className="size-3.5 shrink-0 text-warning" />
        <span className="min-w-0 flex-1 truncate text-foreground">
          {t('ccQueueGateApproval')}{ctx.kind ? <span className="text-muted-foreground"> · {ctx.kind}</span> : null}
        </span>
        <span className="inline-flex shrink-0 items-center gap-0.5 text-muted-foreground">{t('ccQueueApprove')}<ChevronRight className="size-3" /></span>
      </Link>
    );
  }
  return (
    <Link
      href={ctx.story_id ? `/board?story=${ctx.story_id}` : '/board'}
      className={`flex items-center gap-2 rounded-lg border border-l-2 border-border bg-card p-2.5 text-xs transition hover:border-muted-foreground/30 ${PRIORITY_BORDER[item.priority]}`}
    >
      <GitPullRequest className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-foreground">
        <span className="text-muted-foreground">{t('ccQueueReviewMerge')} · </span>{item.title ?? ctx.story_id?.slice(0, 6)}
      </span>
      <span className="inline-flex shrink-0 items-center gap-0.5 text-muted-foreground">{t('ccQueueReview')}<ChevronRight className="size-3" /></span>
    </Link>
  );
}

function AttentionRow({ item, resolveName, epicTitles }: { item: AttentionItem; resolveName: (id: string | null | undefined) => string | null; epicTitles: Record<string, string> }) {
  const t = useTranslations('dashboard');
  // id+enum+time → 카피 조합(raw error/log 없음). entity 제목 resolve(없으면 타입 라벨)·정체 분·게이트.
  const entity = resolveName(item.entity_id) ?? epicTitles[item.entity_id] ?? item.entity_type;
  const mins = minutesSince(item.stuck_since);
  const gate = item.gate_type ?? t('ccGateGeneric');
  return (
    <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 p-2.5 text-xs">
      <span className="mt-1 size-1.5 shrink-0 rounded-full bg-warning" aria-hidden="true" />
      <p className="min-w-0 flex-1 text-foreground">
        <span className="font-medium">{entity}</span>{' '}
        <span className="text-muted-foreground">{t('ccAgentStuck', { minutes: mins, gate })}</span>
      </p>
    </div>
  );
}

export function ActionZone({ data, resolveName, epicTitles }: {
  data: MyActions | null;
  resolveName: (id: string | null | undefined) => string | null;
  epicTitles: Record<string, string>;
}) {
  const t = useTranslations('dashboard');
  const queue = data?.action_queue.items ?? [];
  const attention = data?.attention.items ?? [];
  const hasPending = (data?.attention.pending.length ?? 0) > 0;
  const isClear = data?.is_clear === true;

  return (
    <section aria-label={t('ccZoneActions')} className="space-y-3 rounded-xl border border-border bg-card/40 p-3">
      <h3 className="text-sm font-semibold text-foreground">{t('ccZoneActions')}</h3>

      {/* 큐+주의 0 & is_clear → 차분한 "괜찮다" 빈 상태(loud X) */}
      {isClear && queue.length === 0 && attention.length === 0 ? (
        <div className="flex flex-col items-center gap-1.5 py-8 text-center">
          <CheckCircle2 className="size-6 text-success/70" />
          <p className="text-sm font-medium text-foreground">{t('ccClearTitle')}</p>
          <p className="text-xs text-muted-foreground">{t('ccClearBody')}</p>
        </div>
      ) : (
        <>
          {/* 주의 — 자동 감지 */}
          {attention.length > 0 || hasPending ? (
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5">
                <AlertTriangle className="size-3 text-warning" />
                <span className="text-[11px] font-medium text-foreground">{t('ccAttentionTitle')}</span>
                <span className="rounded bg-muted px-1 py-px text-[10px] text-muted-foreground">{t('ccAutoTag')}</span>
              </div>
              {attention.map((a, i) => (
                <AttentionRow key={`${a.entity_id}-${i}`} item={a} resolveName={resolveName} epicTitles={epicTitles} />
              ))}
              {/* pending 감지(CC-BE.2) — mock 0·미세 "준비중"만 */}
              {hasPending ? <p className="text-[10px] text-muted-foreground/60">{t('ccAttentionMorePending')}</p> : null}
            </div>
          ) : null}

          {/* 행동 큐 — BE 정렬 순서 유지(재정렬 X) */}
          <div className="space-y-1.5">
            <span className="text-[11px] font-medium text-foreground">{t('ccQueueTitle')}</span>
            {queue.length > 0 ? (
              queue.map((q, i) => <QueueRow key={`${q.type}-${i}`} item={q} />)
            ) : (
              <p className="text-xs text-muted-foreground">{t('ccQueueEmpty')}</p>
            )}
          </div>
        </>
      )}
    </section>
  );
}
