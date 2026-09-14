'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/card';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { WorkspaceFrameTabs } from '@/components/workspace/workspace-frame-tabs';
import { fetchWorkList } from './fetch-work-list';
import { filterWorkList, type WorkListFilters } from './filter-work-list';
import { WorkListRowView } from './work-list-row';
import type { WorkList } from './derive-work-list';

/**
 * story #3844(UX-v3·FE 4·일감 1) — 「일감」 목록 탭 쉘. fetch(fetch-work-list.ts) →
 * derive(내부에서 이미 완료) → filter(filter-work-list.ts, URL 쿼리 4개 goal/hypothesis/
 * mine/delegated) → 렌더 순서. 필터 상태는 URL이 SSOT(뒤로가기/새로고침에서 안 사라짐 —
 * useState 로컬 상태였다면 새로고침마다 초기화되는 결함 클래스).
 */
function useWorkListFilters(): [WorkListFilters, (next: Partial<WorkListFilters>) => void] {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const filters: WorkListFilters = useMemo(() => ({
    goalId: searchParams.get('goal'),
    hypothesisId: searchParams.get('hypothesis'),
    mineOnly: searchParams.get('mine') === 'true',
    delegatedOnly: searchParams.get('delegated') === 'true',
  }), [searchParams]);

  const setFilters = useCallback((next: Partial<WorkListFilters>) => {
    const merged = { ...filters, ...next };
    const params = new URLSearchParams();
    if (merged.goalId) params.set('goal', merged.goalId);
    if (merged.hypothesisId) params.set('hypothesis', merged.hypothesisId);
    if (merged.mineOnly) params.set('mine', 'true');
    if (merged.delegatedOnly) params.set('delegated', 'true');
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  }, [filters, pathname, router]);

  return [filters, setFilters];
}

export function WorkListShell({ projectId }: { projectId: string }) {
  const t = useTranslations('workList');
  const [data, setData] = useState<WorkList | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [filters, setFilters] = useWorkListFilters();

  useEffect(() => {
    let cancelled = false;
    // org-briefing-shell.tsx::useTodayData 선례(재시도마다 헌 에러 배너 먼저 걷기)와 동형.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoadError(false);
    fetchWorkList(projectId)
      .then((wl) => { if (!cancelled) setData(wl); })
      .catch(() => { if (!cancelled) setLoadError(true); });
    return () => { cancelled = true; };
  }, [projectId, reloadNonce]);

  // 필터 후보(목표/가설 셀렉트 옵션)는 필터링 «전» 전체 목록에서 뽑는다 — 필터를 걸수록
  // 자기 자신을 고를 옵션이 사라지는 lock-out을 막는다.
  const goalOptions = useMemo(() => data?.groups.map((g) => ({ id: g.goalId, title: g.title })) ?? [], [data]);
  const hypothesisOptions = useMemo(() => {
    const seen = new Map<string, true>();
    for (const g of data?.groups ?? []) for (const s of g.stories) for (const id of s.hypothesisIds) seen.set(id, true);
    return [...seen.keys()];
  }, [data]);

  const filtered = data ? filterWorkList(data, filters) : null;

  return (
    <>
      <TopBarSlot title={<h1 className="text-sm font-medium">{t('title')}</h1>} showContextChip />
      <div className="space-y-3 p-4">
        <WorkspaceFrameTabs active="workList" />

        {data && filtered ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <select
                aria-label={t('filterGoalAriaLabel')}
                className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground"
                value={filters.goalId ?? ''}
                onChange={(e) => setFilters({ goalId: e.target.value || null })}
              >
                <option value="">{t('filterAllGoals')}</option>
                {goalOptions.map((g) => <option key={g.id} value={g.id}>{g.title}</option>)}
              </select>
              {hypothesisOptions.length > 0 ? (
                <select
                  aria-label={t('filterHypothesisAriaLabel')}
                  className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground"
                  value={filters.hypothesisId ?? ''}
                  onChange={(e) => setFilters({ hypothesisId: e.target.value || null })}
                >
                  <option value="">{t('filterAllHypotheses')}</option>
                  {hypothesisOptions.map((id) => <option key={id} value={id}>{id}</option>)}
                </select>
              ) : null}
              <button
                type="button"
                aria-pressed={filters.mineOnly}
                onClick={() => setFilters({ mineOnly: !filters.mineOnly, delegatedOnly: false })}
                className={`h-8 rounded-md border px-3 text-xs font-medium transition ${filters.mineOnly ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:text-foreground'}`}
              >
                {t('filterMine')}
              </button>
              <button
                type="button"
                aria-pressed={filters.delegatedOnly}
                onClick={() => setFilters({ delegatedOnly: !filters.delegatedOnly, mineOnly: false })}
                className={`h-8 rounded-md border px-3 text-xs font-medium transition ${filters.delegatedOnly ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:text-foreground'}`}
              >
                {t('filterDelegated')}
              </button>
            </div>

            {data.partial ? (
              <p className="text-xs text-muted-foreground">{t('partialNotice')}</p>
            ) : null}

            {filtered.groups.length === 0 ? (
              <Card className="p-6 text-center text-sm text-muted-foreground">{t('emptyStateTitle')}</Card>
            ) : (
              <div className="space-y-4">
                {filtered.groups.map((group) => (
                  <div key={group.goalId} className="space-y-2">
                    <div className="flex items-center gap-2 px-1">
                      <h2 className="text-sm font-semibold text-foreground">{group.title}</h2>
                      <span className="text-xs text-muted-foreground">
                        {t('goalProgressLabel', { done: group.doneCount, total: group.totalCount })}
                      </span>
                    </div>
                    <div className="space-y-3">
                      {group.stories.map((story) => (
                        <Card key={story.storyId} className="overflow-hidden">
                          <div className="border-b border-border bg-muted/30 px-3 py-2 text-xs font-medium text-muted-foreground">
                            {story.title}
                          </div>
                          {story.rows.map((row) => <WorkListRowView key={row.id} row={row} />)}
                        </Card>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : loadError ? (
          <Card className="p-6 text-center text-sm text-muted-foreground">
            {t('loadErrorTitle')}
            <button type="button" className="ml-2 text-primary hover:underline" onClick={() => setReloadNonce((n) => n + 1)}>
              ↻
            </button>
          </Card>
        ) : (
          <div className="p-4 text-sm text-muted-foreground">…</div>
        )}
      </div>
    </>
  );
}
