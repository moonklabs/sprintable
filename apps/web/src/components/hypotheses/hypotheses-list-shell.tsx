'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { HYPOTHESIS_STATUSES, type HypothesisStatus } from '@sprintable/core-storage';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { WorkspaceFrameTabs } from '@/components/workspace/workspace-frame-tabs';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { cn } from '@/lib/utils';
import { HypothesisStatusBadge } from './hypothesis-status-badge';
import { fetchWorkList, type FetchedWorkList } from '@/components/work-list/fetch-work-list';

/**
 * story #3989(「일감」 흡수 3/N·FE) — 전수 가설 집(일감 「가설」 보기). ⌘K는 페이지
 * 네비만 하고 개별 엔티티를 검색하지 않아(worklist-6item-absorption doc §검증1)
 * 전수 가설의 집이 갭이었다 — work-list-shell.tsx가 이미 fetchWorkList로 받는
 * hypotheses 원본을 그대로 재사용한다(새 BE 0). 상세는 flow 페이지의 기존
 * `?hypothesis=<id>` 딥링크(HypothesisNarrativePanel, story #2533)를 그대로 쓰고,
 * 연결된 일은 work-list의 기존 `?hypothesis=<id>` 필터(useWorkListFilters)를 그대로
 * 쓴다 — 둘 다 발명 0.
 */
export function HypothesesListShell({ projectId }: { projectId: string }) {
  const t = useTranslations('workList');
  const tc = useTranslations('common');
  const tNav = useTranslations('nav');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const params = useParams<{ ws: string; proj: string }>();

  const [fetched, setFetched] = useState<FetchedWorkList | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // work-list-shell.tsx와 동형(재시도마다 헌 에러 배너 먼저 걷기).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoadError(false);
    fetchWorkList(projectId)
      .then((wl) => { if (!cancelled) setFetched(wl); })
      .catch(() => { if (!cancelled) setLoadError(true); });
    return () => { cancelled = true; };
  }, [projectId, reloadNonce]);

  // work-list-shell.tsx의 useWorkListFilters와 동형 원칙 — 필터 상태는 URL이 SSOT.
  const statusFilter = searchParams.get('status') as HypothesisStatus | null;
  const setStatusFilter = useCallback((status: HypothesisStatus | null) => {
    const p = new URLSearchParams(searchParams);
    if (status) p.set('status', status); else p.delete('status');
    const qs = p.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  }, [searchParams, pathname, router]);

  const hypotheses = fetched?.hypotheses ?? [];
  const filtered = statusFilter ? hypotheses.filter((h) => h.status === statusFilter) : hypotheses;

  const goToDetail = useCallback((id: string) => {
    router.push(`/${params.ws}/${params.proj}/flow?hypothesis=${id}`);
  }, [router, params]);
  const goToLinkedWork = useCallback((id: string) => {
    router.push(`/${params.ws}/${params.proj}/work-list?hypothesis=${id}`);
  }, [router, params]);

  return (
    <>
      <TopBarSlot
        title={<h1 className="text-sm font-medium">{tNav('hypothesis')}</h1>}
        showContextChip
      />
      <div className="min-w-0 flex-1 space-y-3 p-4">
      <WorkspaceFrameTabs active="hypothesis" />

      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => setStatusFilter(null)}
          className={cn(
            'rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors',
            statusFilter === null
              ? 'border-primary/40 bg-primary/10 text-primary'
              : 'border-border text-muted-foreground hover:bg-muted/50',
          )}
        >
          {t('hypothesesFilterAll')}
        </button>
        {HYPOTHESIS_STATUSES.map((status) => (
          <button
            key={status}
            type="button"
            onClick={() => setStatusFilter(statusFilter === status ? null : status)}
            className={cn(
              'rounded-lg transition-opacity',
              statusFilter !== null && statusFilter !== status && 'opacity-50 hover:opacity-100',
            )}
          >
            <HypothesisStatusBadge status={status} />
          </button>
        ))}
      </div>

      {fetched ? (
        filtered.length === 0 ? (
          <EmptyState title={t('hypothesesEmptyTitle')} />
        ) : (
          <div className="space-y-2">
            {filtered.map((h) => (
              <Card key={h.id} className="space-y-1.5 p-3">
                <button
                  type="button"
                  onClick={() => goToDetail(h.id)}
                  className="block w-full text-left text-sm font-medium text-foreground hover:underline"
                >
                  {h.statement}
                </button>
                <div className="flex items-center justify-between gap-2">
                  <HypothesisStatusBadge status={h.status} />
                  {h.story_ids.length > 0 ? (
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      className="h-auto p-0 text-xs"
                      onClick={() => goToLinkedWork(h.id)}
                    >
                      {t('hypothesesLinkedWorkCta')}
                    </Button>
                  ) : null}
                </div>
              </Card>
            ))}
          </div>
        )
      ) : loadError ? (
        <Card className="p-6 text-center text-sm text-muted-foreground">
          {t('loadErrorTitle')}
          <Button type="button" variant="link" className="ml-2 h-auto p-0" onClick={() => setReloadNonce((n) => n + 1)}>
            {tc('retry')}
          </Button>
        </Card>
      ) : (
        <div className="space-y-2">
          <Skeleton variant="rect" className="h-16 w-full" />
          <Skeleton variant="rect" className="h-16 w-full" />
          <Skeleton variant="rect" className="h-16 w-full" />
        </div>
      )}
      </div>
    </>
  );
}
