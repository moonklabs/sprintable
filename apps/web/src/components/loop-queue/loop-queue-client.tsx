'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { fetchWithAuth } from '@/lib/db/client';
import { cn } from '@/lib/utils';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import {
  parseLoopQueuePage, parseProjectSlugMap, deriveLoopQueueItems,
  type LoopQueueItem, type LoopQueueKind,
} from './derive-loop-queue';
import type { ViewerContext } from '../org-briefing/derive-attention-clusters';
import { parseTeamMembers } from '../org-briefing/derive-workforce-face';
// story #2858 — CrossProjectTag는 attention-cluster-board.tsx의 단일 정의를 재사용한다
// (페드루 PO 판정 2026-08-21, 2851 교훈 — 별개 페이지라도 로컬 재정의 금지).
import { CrossProjectTag } from '../org-briefing/attention-cluster-board';

// story #2858(loop-closure P2) AC1 — org 스코프: measure_after 오래된 순 전량 페이지네이션.
// BE가 이미 정렬해서 낸다(loop_measure_due.py: items.sort(key=measure_after)) — FE 재정렬 X.
const PAGE_SIZE = 25;

const KIND_BADGE_KEY: Record<LoopQueueKind, string> = {
  overdueHypothesis: 'clusterUnclosedBadgeOverdueHypothesis',
  overdueGoal: 'clusterUnclosedBadgeOverdueGoal',
  outcomeMissing: 'clusterUnclosedBadgeOutcomeMissing',
};
const KIND_DAYS_KEY: Record<LoopQueueKind, string> = {
  overdueHypothesis: 'clusterUnclosedDaysOverdue',
  overdueGoal: 'clusterUnclosedDaysOverdue',
  outcomeMissing: 'clusterUnclosedDaysDone',
};

function QueueRow({ item, memberNames, onClaim, claiming }: {
  item: LoopQueueItem;
  memberNames: Record<string, string>;
  onClaim: (item: LoopQueueItem) => void;
  claiming: boolean;
}) {
  // story #2210(i18n-key-coverage.test.ts) — 이 파서는 파일 내 변수명 기준으로 스캔한다.
  // LoopQueueClient도 t=useTranslations('loopQueue')를 쓰므로 여기서도 t를 재사용하면
  // 두 네임스페이스 키가 서로 오염된 것으로(가짜 missing) 오탐된다 — 변수명을 분리한다.
  const tCluster = useTranslations('orgBriefing');
  const tq = useTranslations('loopQueue');
  const ownerName = item.ownerMemberId ? memberNames[item.ownerMemberId] : null;

  return (
    <div className="flex flex-col gap-2 border-t border-border px-4 py-3 sm:flex-row sm:items-center sm:gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link href={item.href} className="min-w-0 truncate text-sm font-medium text-foreground hover:underline">
            {item.title}
          </Link>
          <CrossProjectTag label={item.crossProjectLabel} />
          <Badge variant="warning" className="shrink-0">{tCluster(KIND_BADGE_KEY[item.kind])}</Badge>
          {item.overdueDays !== null ? (
            <span className="shrink-0 rounded-md bg-warning-tint px-2 py-0.5 text-[11px] font-semibold text-foreground">
              {tCluster(KIND_DAYS_KEY[item.kind], { n: item.overdueDays })}
            </span>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {ownerName ? (
          <span className="text-[11.5px] text-muted-foreground">{tq('claimedBy', { name: ownerName })}</span>
        ) : (
          <>
            <span className="text-[11.5px] text-muted-foreground">{tq('unclaimed')}</span>
            <button
              type="button"
              disabled={claiming}
              onClick={() => onClaim(item)}
              className="shrink-0 rounded-md border border-border px-2.5 py-1 text-[11.5px] font-medium text-foreground transition-colors hover:bg-muted/50 disabled:opacity-50"
            >
              {tq('claimAction')}
            </button>
          </>
        )}
        <Link href={item.href} className="shrink-0 text-[11.5px] font-medium text-primary">
          {tq('judgeAction')}
        </Link>
      </div>
    </div>
  );
}

export function LoopQueueClient() {
  const t = useTranslations('loopQueue');
  const { orgId, orgMemberships, projectId, currentTeamMemberId } = useDashboardContext();
  const orgSlug = orgMemberships.find((o) => o.orgId === orgId)?.orgSlug;
  const viewer = useMemo<ViewerContext>(() => ({ orgSlug, activeProjectId: projectId }), [orgSlug, projectId]);

  const [unclaimedOnly, setUnclaimedOnly] = useState(false);
  const [offset, setOffset] = useState(0);
  const [rawItems, setRawItems] = useState<LoopQueueItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [memberNames, setMemberNames] = useState<Record<string, string>>({});
  const [claimingId, setClaimingId] = useState<string | null>(null);

  useEffect(() => { setOffset(0); }, [unclaimedOnly]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (unclaimedOnly) params.set('unclaimed_only', 'true');
      const [queueJson, membersJson, projectsJson] = await Promise.all([
        fetchWithAuth(`/api/loop-measure-due/queue?${params}`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
        fetchWithAuth('/api/team-members').then((r) => (r.ok ? r.json() : null)).catch(() => null),
        fetchWithAuth('/api/projects').then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ]);
      if (cancelled) return;
      const page = parseLoopQueuePage(queueJson);
      const slugMap = parseProjectSlugMap(projectsJson);
      setMemberNames(parseTeamMembers(membersJson));
      setTotal(page.total);
      setRawItems(deriveLoopQueueItems(page.items, t, viewer, slugMap));
    };
    void load();
    return () => { cancelled = true; };
  }, [offset, unclaimedOnly, t, viewer]);

  const handleClaim = async (item: LoopQueueItem) => {
    if (!currentTeamMemberId) return;
    setClaimingId(item.id);
    try {
      const url = item.workItemType === 'hypothesis' ? `/api/hypotheses/${item.workItemId}` : `/api/goals/${item.workItemId}`;
      const body = item.workItemType === 'hypothesis'
        ? { owner_member_id: currentTeamMemberId }
        : { assignee_id: currentTeamMemberId };
      const res = await fetchWithAuth(url, { method: 'PATCH', body: JSON.stringify(body) });
      if (res.ok) {
        // story #2858 AC3 — claim 후 행에 담당 표시(낙관적 반영, 재조회 없이 즉시 반영). 현재
        // 사용자는 이미 team-members 응답에 포함돼 있어(자기 자신) memberNames 갱신 불요.
        setRawItems((prev) => prev?.map((it) => (it.id === item.id ? { ...it, ownerMemberId: currentTeamMemberId } : it)) ?? prev);
      }
    } finally {
      setClaimingId(null);
    }
  };

  const items = rawItems ?? [];
  const hasPrev = offset > 0;
  const hasNext = offset + PAGE_SIZE < total;

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-base font-semibold text-foreground">{t('title')}</h1>
          <p className="text-[11.5px] text-muted-foreground">{t('subtitle')}</p>
        </div>
        <label className="flex shrink-0 items-center gap-2 text-[12.5px] text-foreground">
          <input
            type="checkbox"
            checked={unclaimedOnly}
            onChange={(e) => setUnclaimedOnly(e.target.checked)}
            className="size-3.5"
          />
          {t('unclaimedOnlyToggle')}
        </label>
      </div>

      {rawItems === null ? (
        <div className="rounded-2xl border border-border bg-card p-6 text-center text-sm text-muted-foreground">
          {t('loading')}
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-1.5 rounded-2xl border border-border bg-card px-5 py-10 text-center">
          <AlertTriangle className="size-5 text-muted-foreground" aria-hidden="true" />
          <p className="text-sm font-medium text-foreground">{t('empty')}</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-border bg-card">
          {items.map((item) => (
            <QueueRow key={item.id} item={item} memberNames={memberNames} onClaim={handleClaim} claiming={claimingId === item.id} />
          ))}
        </div>
      )}

      {rawItems !== null && total > 0 ? (
        <div className="mt-3 flex items-center justify-between text-[11.5px] text-muted-foreground">
          <span>{t('pageSummary', { from: offset + 1, to: Math.min(offset + PAGE_SIZE, total), total })}</span>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={!hasPrev}
              onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
              className={cn('rounded-md border border-border px-2.5 py-1 font-medium text-foreground', !hasPrev && 'opacity-40')}
            >
              {t('prevPage')}
            </button>
            <button
              type="button"
              disabled={!hasNext}
              onClick={() => setOffset((o) => o + PAGE_SIZE)}
              className={cn('rounded-md border border-border px-2.5 py-1 font-medium text-foreground', !hasNext && 'opacity-40')}
            >
              {t('nextPage')}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
