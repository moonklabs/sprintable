'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { isPending, type MyActions, type Overview } from './types';
import { ActionZone } from './action-zone';
import { OverviewZone } from './overview-zone';

/**
 * E-MODERN [Track C] 커맨드 센터 — 현 대시보드 위젯 교체. 2구역+헤더.
 * "괜찮다 / 내가 OO 해야" 한눈에. canonical 부품·색=신호·pending_data graceful(mock-0 금지).
 * 데이터: org-scope BE 2엔드포인트(caller 쿠키 resolve·param 불요) + team-members(이름 resolve).
 */

function unwrap<T>(json: unknown): T | null {
  if (!json || typeof json !== 'object') return null;
  const d = (json as { data?: unknown }).data;
  return (d ?? json) as T;
}

export function CommandCenter({ projectName }: { projectName?: string | null }) {
  const t = useTranslations('dashboard');
  const [myActions, setMyActions] = useState<MyActions | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [memberNames, setMemberNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [ma, ov, members] = await Promise.all([
        fetch('/api/dashboard/my-actions').then((r) => (r.ok ? r.json() : null)).catch(() => null),
        fetch('/api/dashboard/overview').then((r) => (r.ok ? r.json() : null)).catch(() => null),
        fetch('/api/team-members').then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ]);
      setMyActions(unwrap<MyActions>(ma));
      setOverview(unwrap<Overview>(ov));
      const names: Record<string, string> = {};
      const rows = (unwrap<{ data?: { id: string; name: string }[] }>(members)?.data
        ?? (members as { data?: { id: string; name: string }[] } | null)?.data) ?? [];
      for (const m of Array.isArray(rows) ? rows : []) names[m.id] = m.name;
      setMemberNames(names);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // 에픽 제목 맵(overview epics) — recent_changes/attention id resolve 보조(member 맵과 함께).
  const epicTitles: Record<string, string> = {};
  for (const e of overview?.project_status.epics ?? []) epicTitles[e.epic_id] = e.title;
  const resolveName = (id: string | null | undefined): string | null =>
    id ? (memberNames[id] ?? epicTitles[id] ?? null) : null;

  const fleet = overview?.fleet;

  return (
    <div className="space-y-4">
      {/* 헤더: 커맨드 센터 + 프로젝트 + 우측 함대 라이브 */}
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-sm font-semibold text-foreground">{t('commandCenter')}</h2>
          {projectName ? <span className="text-xs text-muted-foreground">· {projectName}</span> : null}
        </div>
        {fleet ? (
          <div className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-[11px]">
            <span className="font-medium text-foreground">{t('ccFleet', { count: fleet.total_agents })}</span>
            {isPending(fleet.status_breakdown) ? (
              <span className="text-muted-foreground/70">· {t('ccFleetBreakdownPending')}</span>
            ) : null}
          </div>
        ) : null}
      </header>

      {loading && !myActions && !overview ? (
        <div className="flex items-center gap-2 py-12 text-xs text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t('ccLoading')}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.25fr_1fr]">
          <ActionZone data={myActions} resolveName={resolveName} epicTitles={epicTitles} />
          <OverviewZone data={overview} resolveName={resolveName} />
        </div>
      )}
    </div>
  );
}
