'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { HYPOTHESIS_STATUSES, type HypothesisStatus } from '@sprintable/core-storage';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { WorkspaceFrameTabs } from '@/components/workspace/workspace-frame-tabs';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { cn } from '@/lib/utils';
import { pickEuroJosa } from '@/lib/korean-particle';
import { HypothesisStatusBadge } from './hypothesis-status-badge';
import { fetchHypotheses } from '@/components/work-list/fetch-work-list';
import type { WorkListHypothesisInput } from '@/components/work-list/derive-work-list';

/**
 * story #3989(「일감」 흡수 3/N·FE) — 전수 가설 집(일감 「가설」 보기). ⌘K는 페이지
 * 네비만 하고 개별 엔티티를 검색하지 않아(worklist-6item-absorption doc §검증1)
 * 전수 가설의 집이 갭이었다. 상세는 flow 페이지의 기존 `?hypothesis=<id>` 딥링크
 * (HypothesisNarrativePanel, story #2533)를 그대로 쓰고, 연결된 일은 work-list의
 * 기존 `?hypothesis=<id>` 필터(useWorkListFilters)를 그대로 쓴다 — 둘 다 발명 0.
 *
 * story #3989 CHANGES(페드루 PO) — 처음엔 fetchWorkList(8개 Promise.all)를 통째로
 * 불렀다가, 무관한 원본(예: inbox) 실패에도 이 화면이 통째로 오류로 떨어지고 탭
 * 하나에 요청 8개가 나가던 결함을 지적받았다 — fetchHypotheses(`/api/hypotheses?
 * project_id=` 1콜, fetchWorkList도 내부에서 재사용하는 같은 함수)로 좁힌다.
 */
export function HypothesesListShell({ projectId }: { projectId: string }) {
  const t = useTranslations('workList');
  const tc = useTranslations('common');
  const tNav = useTranslations('nav');
  // story #4383 CI RED 처방(페드루 PO 실측) — 상태 필터 칩의 aria-label. 보이는 라벨은
  // HypothesisStatusBadge 내부(hypotheses 네임스페이스)가 결정해 이 컴포넌트에선 안
  // 보이므로(가드가 정적 라벨로 오판) 같은 키(`status${Capitalized}`)로 여기서도 뽑아
  // aria-label에 품는다(같은 사실=같은 말, 새 문구 0).
  const tHypotheses = useTranslations('hypotheses');
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const params = useParams<{ ws: string; proj: string }>();

  const [hypotheses, setHypotheses] = useState<WorkListHypothesisInput[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // work-list-shell.tsx와 동형(재시도마다 헌 에러 배너 먼저 걷기).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoadError(false);
    fetchHypotheses(projectId)
      .then((data) => { if (!cancelled) setHypotheses(data); })
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

  const filtered = statusFilter ? (hypotheses ?? []).filter((h) => h.status === statusFilter) : (hypotheses ?? []);

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
          aria-pressed={statusFilter === null}
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
        {HYPOTHESIS_STATUSES.map((status) => {
          const statusLabelKey = `status${status.charAt(0).toUpperCase()}${status.slice(1)}` as 'statusProposed';
          const statusLabel = tHypotheses(statusLabelKey);
          // §⑤ 규율(story #3900) — 값 의존 조사(으로/로)는 템플릿에 못 박지 않는다. 상태
          // 라벨(제안됨·측정中 등)마다 받침 유무가 갈려 en 템플릿과 다르게 조사까지 미리
          // 합쳐 하나의 값으로 넘긴다(historyFieldChanged류와 동형 처리).
          const statusLabelWithJosa = locale === 'ko' ? `${statusLabel}${pickEuroJosa(statusLabel)}` : statusLabel;
          return (
            <button
              key={status}
              type="button"
              aria-pressed={statusFilter === status}
              aria-label={t('hypothesesStatusFilterAriaLabel', { label: statusLabelWithJosa })}
              onClick={() => setStatusFilter(statusFilter === status ? null : status)}
              className={cn(
                'rounded-lg transition-opacity',
                statusFilter !== null && statusFilter !== status && 'opacity-50 hover:opacity-100',
              )}
            >
              <HypothesisStatusBadge status={status} />
            </button>
          );
        })}
      </div>

      {hypotheses ? (
        filtered.length === 0 ? (
          hypotheses.length === 0 ? (
            <EmptyState title={t('hypothesesEmptyTitle')} />
          ) : (
            // story #3989 CHANGES(페드루 PO) — «전혀 없음»과 «필터에 맞는 것 없음」은
            // 다른 사실이다(가설은 있는데 지금 고른 상태에만 없는 것) — 필터를 지울 수
            // 있어야 한다(panelClearFilters 재사용, 새 낱말 0).
            <EmptyState
              title={t('hypothesesFilterEmptyTitle')}
              action={
                <Button type="button" variant="outline" size="sm" onClick={() => setStatusFilter(null)}>
                  {t('panelClearFilters')}
                </Button>
              }
            />
          )
        ) : (
          <div className="space-y-2">
            {filtered.map((h, index) => (
              <Card key={h.id} className="space-y-1.5 p-3">
                <button
                  type="button"
                  onClick={() => goToDetail(h.id)}
                  aria-label={t('hypothesesGoToDetailAriaLabel', { n: index + 1, label: h.statement })}
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
                      aria-label={t('hypothesesGoToLinkedWorkAriaLabel', { n: index + 1, label: t('hypothesesLinkedWorkCta') })}
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
