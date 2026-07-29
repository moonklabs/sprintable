'use client';

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ShieldCheck, GitPullRequest, Ban, AlertTriangle, CheckCircle2, ChevronRight, History } from 'lucide-react';
import { type MyActions, type Priority, type QueueItem, type AttentionItem } from './types';
import { selectVisibleQueue, splitRenderableQueue, countChangedSince, countAttentionChangedSince, getLastSeenMs, markSeenNow, minutesAgo } from './derive-action-zone';

const QUEUE_CAP = 5; // now-face.tsx CAP 관례 재사용(§7-4 잘림-보이기).

// story #2288: use-recent-docs.ts 관례 재사용 — localStorage 읽기는 useSyncExternalStore로
// (SSR 스냅샷=null, 클라 하이드레이션 후 실값) 해 setState-in-effect 없이 hydration-safe.
function subscribeNoop() { return () => {}; }
function getServerSnapshot() { return null; }

// 우선순위 좌border(색=신호): danger/warn만 색·info는 중립(canonical §4 alert만 색).
const PRIORITY_BORDER: Record<Priority, string> = {
  danger: 'border-l-destructive',
  warn: 'border-l-warning',
  info: 'border-l-border',
};

// story #2288: 정상 경로에서는 splitRenderableQueue가 미확인 타입을 미리 걸러내므로 이 아래
// 마지막 분기는 방어선(defense-in-depth)이다 — 직접 단위테스트하려고 export한다.
export function QueueRow({ item }: { item: QueueItem }) {
  const t = useTranslations('dashboard');
  const ctx = item.context as { gate_id?: string; story_id?: string; kind?: string; status?: string; blocked_story_id?: string };
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
  // story #2288: BE의 'my_blockers'(내가 막고 있음)를 review_merge로 오인 렌더하던 것을
  // 바로잡는다 — types.ts 참조. §2 dedup(같은 다음 발이면 한 줄)은 이 슬라이스 범위 밖.
  if (item.type === 'my_blockers') {
    return (
      <Link
        href={ctx.blocked_story_id ? `/board?story=${ctx.blocked_story_id}` : '/board'}
        className={`flex items-center gap-2 rounded-lg border border-l-2 border-border bg-card p-2.5 text-xs transition hover:border-muted-foreground/30 ${PRIORITY_BORDER[item.priority]}`}
      >
        <Ban className="size-3.5 shrink-0 text-warning" />
        <span className="min-w-0 flex-1 truncate text-foreground">
          <span className="text-muted-foreground">{t('ccQueueMyBlocker')} · </span>{item.title ?? ctx.story_id?.slice(0, 6)}
        </span>
        <span className="inline-flex shrink-0 items-center gap-0.5 text-muted-foreground">{t('ccQueueReview')}<ChevronRight className="size-3" /></span>
      </Link>
    );
  }
  if (item.type === 'review_merge') {
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
  // story #2288, PO 지적(2026-07-29): 'my_blockers'가 이 자리(암묵적 else)에 떨어져
  // review_merge로 오인 렌더되던 것이 그 버그였다 — BE가 FE 미선언 타입을 보내도 다시는
  // «남의 문구로» 조용히 렌더되지 않게, 인식 못한 타입은 안전한 미확인 표시로 가른다.
  // ⛔TS 유니온은 컴파일타임에만 닫혀 있다 — BE가 실제로 새 타입을 보내는 것은 여기서만 잡힌다.
  const unknownType: string = item.type;
  if (process.env.NODE_ENV !== 'production') {
    console.warn('ActionZone/QueueRow: unrecognized action_queue item type', { type: unknownType });
  }
  return (
    <div className="flex items-center gap-2 rounded-lg border border-l-2 border-dashed border-border bg-card p-2.5 text-xs text-muted-foreground">
      <span className="min-w-0 flex-1 truncate">{t('ccQueueUnknownType')}</span>
    </div>
  );
}

function AttentionRow({ item, resolveName, epicTitles }: { item: AttentionItem; resolveName: (id: string | null | undefined) => string | null; epicTitles: Record<string, string> }) {
  const t = useTranslations('dashboard');
  // id+enum → 카피 조합(raw error/log 없음). entity 제목 resolve(없으면 타입 라벨)·게이트.
  // 감시톤 재프레임(command-center-surveillance-reframe-handoff): stuck_since는 항목 surfacing
  // 트리거로만 쓰이고(위쪽 필터링), 여기선 경과 분(minutesSince) 계산·표시를 걷었다 — "대기는
  // 경보가 아니라 상태"(§1/§8 시간 강조 0). 색도 warning→info/muted 중립 톤.
  const entity = resolveName(item.entity_id) ?? epicTitles[item.entity_id] ?? item.entity_type;
  const gate = item.gate_type ?? t('ccGateGeneric');
  return (
    <div className="flex items-start gap-2 rounded-lg border border-border bg-card p-2.5 text-xs">
      <span className="mt-1 size-1.5 shrink-0 rounded-full bg-info/60" aria-hidden="true" />
      <p className="min-w-0 flex-1 text-foreground">
        <span className="font-medium">{entity}</span>{' '}
        <span className="text-muted-foreground">{t('ccAgentStuck', { gate })}</span>
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
  const queue = useMemo(() => data?.action_queue.items ?? [], [data]);
  const attention = useMemo(() => data?.attention.items ?? [], [data]);
  const hasPending = (data?.attention.pending.length ?? 0) > 0;
  const isClear = data?.is_clear === true;

  // PO 지시(2026-07-29): QueueRow가 못 알아보는 타입은 개별 소음 줄 대신 목록에서 걷어내고
  // 요약 한 줄로만 말한다(#2265 ChatProofSection skippedCount 관례) — 잘림과 다른 사실.
  const { renderable: renderableQueue, unrenderableCount } = useMemo(() => splitRenderableQueue(queue), [queue]);
  // story #2288 §8-4·§7-4: 자를 땐 review_merge부터, 잘렸으면 반드시 말한다.
  const { visible: visibleQueue, cutCount } = selectVisibleQueue(renderableQueue, QUEUE_CAP);

  // story #2288 §8-8: 방문 사이 새로 생긴 것 — action_queue 3관계뿐 아니라 attention(감지
  // 신호, org-scope이나 「지금 볼 것」에 이미 뜨는 것)도 PO 확認(2026-07-29)으로 포함.
  // 처음 방문(기준점 없음)은 0 — 「모름」을 「전부 새것」으로 지어내지 않는다(getLastSeenMs 참조).
  // 읽기는 useSyncExternalStore(하이드레이션 안전, setState-in-effect 없음) · 쓰기만 effect로.
  const lastSeenMs = useSyncExternalStore(subscribeNoop, getLastSeenMs, getServerSnapshot);
  const awayCount = useMemo(
    () => countChangedSince(queue, lastSeenMs) + countAttentionChangedSince(attention, lastSeenMs),
    [queue, attention, lastSeenMs],
  );
  const lastSeenMinutesAgo = minutesAgo(lastSeenMs);
  useEffect(() => {
    if (!data) return;
    markSeenNow(Date.now());
  }, [data]);
  const lastSeenAgo = lastSeenMinutesAgo === null ? null
    : lastSeenMinutesAgo < 60 ? t('ccMinAgo', { n: lastSeenMinutesAgo })
    : lastSeenMinutesAgo < 1440 ? t('ccHourAgo', { n: Math.floor(lastSeenMinutesAgo / 60) })
    : t('ccDayAgo', { n: Math.floor(lastSeenMinutesAgo / 1440) });

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
                <AlertTriangle className="size-3 text-muted-foreground" />
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

          {/* story #2288 §8-8: 자리를 비운 사이 생긴 것 — 접힌 줄, 항목 아님, 빨강 금지(사실이지 나쁜 소식 아님) */}
          {awayCount > 0 ? (
            <div className="flex items-center gap-1.5 rounded-md border border-dashed border-border px-2.5 py-1.5 text-[11px] text-muted-foreground">
              <History className="size-3 shrink-0" aria-hidden="true" />
              <span>
                {t('ccChangedSince', { count: awayCount })}
                {lastSeenAgo ? <span> · {t('ccLastSeenSuffix', { ago: lastSeenAgo })}</span> : null}
              </span>
            </div>
          ) : null}

          {/* 행동 큐 — BE 정렬 순서 유지, 자를 때만 §8-4 순서 적용(재정렬 아님, selectVisibleQueue 참조) */}
          <div className="space-y-1.5">
            <span className="text-[11px] font-medium text-foreground">{t('ccQueueTitle')}</span>
            {visibleQueue.length > 0 ? (
              visibleQueue.map((q, i) => <QueueRow key={`${q.type}-${i}`} item={q} />)
            ) : (
              <p className="text-xs text-muted-foreground">{t('ccQueueEmpty')}</p>
            )}
            {cutCount > 0 ? (
              // ccQueueTruncated 문구는 자리만 확保 — 최종 워딩은 유나 lane(§8-4 규율을
              // 담아 통일된 톤으로 검수 예정, 지금은 기능 검증용 임시 문구).
              <p className="text-[11px] text-muted-foreground">{t('ccQueueTruncated', { shown: visibleQueue.length, total: renderableQueue.length })}</p>
            ) : null}
            {unrenderableCount > 0 ? (
              // ccQueueUnrenderableCount도 자리만 확保 — 최종 워딩은 유나 lane(같은 코멘트,
              // PO 지시 2026-07-29). 「N건은 표시할 수 없음」— 잘림과 다른 사실이라 별도 줄.
              <p className="text-[11px] text-muted-foreground">{t('ccQueueUnrenderableCount', { count: unrenderableCount })}</p>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}
