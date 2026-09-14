'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ListFilter } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { WorkspaceFrameTabs } from '@/components/workspace/workspace-frame-tabs';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { fetchWorkList, type FetchedWorkList } from './fetch-work-list';
import { filterWorkList, type WorkListFilters } from './filter-work-list';
import { WorkListRowView } from './work-list-row';
import { useWorkListSelection } from './use-work-list-selection';
import { WorkListDetailPanel } from './work-list-detail-panel';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { useIsMobile } from '@/hooks/use-mobile';

/** PO 확定(2026-09-14) — 시안 3840 v2 필터 칩 3종 커스터마이즈: 펀넬 아이콘·선택 표시
 * 파란(primary) 테두리·가설 점 마커. OperatorDropdownSelect(components/ui)가 쓰는 것과
 * 동일한 DropdownMenu 프리미티브를 그대로 재사용 — 트리거 안에 아이콘을 넣어야 해서
 * 그 컴포넌트를 감싸는 대신 같은 프리미티브로 얇게 직접 구성한다(새 프리미티브 0). */
function FilterDropdown({
  icon, ariaLabel, selectedLabel, placeholder, options, onSelect,
}: {
  icon: ReactNode;
  ariaLabel: string;
  selectedLabel: string | null;
  placeholder: string;
  options: Array<{ id: string; label: string }>;
  onSelect: (id: string | null) => void;
}) {
  const isSelected = selectedLabel !== null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={ariaLabel}
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn(
              'h-8 gap-1.5 font-medium',
              isSelected && 'border-primary bg-primary/10 text-foreground',
            )}
          >
            {icon}
            <span className="truncate">{selectedLabel ?? placeholder}</span>
          </Button>
        }
      />
      <DropdownMenuContent align="start">
        <DropdownMenuItem onClick={() => onSelect(null)}>{placeholder}</DropdownMenuItem>
        {options.map((o) => (
          <DropdownMenuItem key={o.id} onClick={() => onSelect(o.id)}>{o.label}</DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

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
  const [fetched, setFetched] = useState<FetchedWorkList | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [filters, setFilters] = useWorkListFilters();
  // story #3845(우패널) — 행 선택은 URL이 SSOT(useWorkListFilters와 동일 원칙).
  const [selectedRowId, setSelectedRowId] = useWorkListSelection();
  const isMobile = useIsMobile();

  useEffect(() => {
    let cancelled = false;
    // org-briefing-shell.tsx::useTodayData 선례(재시도마다 헌 에러 배너 먼저 걷기)와 동형.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoadError(false);
    fetchWorkList(projectId)
      .then((wl) => { if (!cancelled) setFetched(wl); })
      .catch(() => { if (!cancelled) setLoadError(true); });
    return () => { cancelled = true; };
  }, [projectId, reloadNonce]);

  const data = fetched?.workList ?? null;

  // 필터 후보(목표/가설 옵션)는 필터링 «전» 전체 목록에서 뽑는다 — 필터를 걸수록 자기
  // 자신을 고를 옵션이 사라지는 lock-out을 막는다.
  const goalOptions = useMemo(() => data?.groups.map((g) => ({ id: g.goalId, label: g.title })) ?? [], [data]);
  const hypothesisIdsInView = useMemo(() => {
    const seen = new Set<string>();
    for (const g of data?.groups ?? []) for (const s of g.stories) for (const id of s.hypothesisIds) seen.add(id);
    return seen;
  }, [data]);
  const hypothesisById = useMemo(() => new Map((fetched?.hypotheses ?? []).map((h) => [h.id, h.statement])), [fetched]);
  const hypothesisOptions = useMemo(
    () => [...hypothesisIdsInView].map((id) => ({ id, label: hypothesisById.get(id) ?? id })),
    [hypothesisIdsInView, hypothesisById],
  );
  const selectedGoalLabel = filters.goalId ? (goalOptions.find((g) => g.id === filters.goalId)?.label ?? null) : null;
  const selectedHypothesisLabel = filters.hypothesisId ? (hypothesisById.get(filters.hypothesisId) ?? filters.hypothesisId) : null;

  const filtered = data ? filterWorkList(data, filters) : null;

  // story #3845(우패널) — 선택된 rowId로 그 row·부모 story·부모 goal을 한 번에 찾는다
  // (filtered 기준 — 필터로 걸러진 행은 화면에 없으니 패널도 열지 않는다, "안 보이는데
  // 패널만 뜨는" 불일치 방지).
  const selectedContext = (() => {
    if (!selectedRowId || !filtered) return null;
    for (const group of filtered.groups) {
      for (const story of group.stories) {
        const row = story.rows.find((r) => r.id === selectedRowId);
        if (row) return { row, goalTitle: group.title, storyId: story.storyId, storyTitle: story.title };
      }
    }
    return null;
  })();

  const detailPanel = selectedContext ? (
    <WorkListDetailPanel
      row={selectedContext.row}
      storyId={selectedContext.storyId}
      storyTitle={selectedContext.storyTitle}
      goalTitle={selectedContext.goalTitle}
      onClose={() => setSelectedRowId(null)}
    />
  ) : null;

  return (
    <>
      <TopBarSlot
        title={
          <div>
            <h1 className="text-sm font-medium">{t('title')}</h1>
            {/* AC4·doc a699be00 §⑤ 「일감 설명」 행 그대로(PO 지적 2026-09-14 — 시안 06d2d61c
                재대조로 누락 발견). */}
            <p className="mt-0.5 text-xs text-muted-foreground">{t('subtitle')}</p>
          </div>
        }
        showContextChip
      />
      {/* story #3845(우패널) — 데스크톱: 목록 옆 고정폭 aside(선택 有일 때만 렌더·
          overflow-y-auto+focus-inset은 패널 자신이 짐). 모바일: Sheet(side="right",
          기존 use-mobile.ts 768 문턱 재사용 — 새 breakpoint 0). */}
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 space-y-3 p-4">
          <WorkspaceFrameTabs active="workList" />

        {data && filtered ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <FilterDropdown
                icon={<ListFilter className="size-3.5 shrink-0" aria-hidden="true" />}
                ariaLabel={t('filterGoalAriaLabel')}
                selectedLabel={selectedGoalLabel}
                placeholder={t('filterAllGoals')}
                options={goalOptions}
                onSelect={(id) => setFilters({ goalId: id })}
              />
              {hypothesisOptions.length > 0 ? (
                <FilterDropdown
                  icon={<span className="size-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />}
                  ariaLabel={t('filterHypothesisAriaLabel')}
                  selectedLabel={selectedHypothesisLabel}
                  placeholder={t('filterAllHypotheses')}
                  options={hypothesisOptions}
                  onSelect={(id) => setFilters({ hypothesisId: id })}
                />
              ) : null}
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-pressed={filters.mineOnly}
                onClick={() => setFilters({ mineOnly: !filters.mineOnly, delegatedOnly: false })}
                className={cn('h-8 font-medium', filters.mineOnly && 'border-primary bg-primary/10 text-foreground')}
              >
                {t('filterMine')}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-pressed={filters.delegatedOnly}
                onClick={() => setFilters({ delegatedOnly: !filters.delegatedOnly, mineOnly: false })}
                className={cn('h-8 font-medium', filters.delegatedOnly && 'border-primary bg-primary/10 text-foreground')}
              >
                {t('filterDelegated')}
              </Button>
            </div>

            {data.partial ? (
              <p className="text-xs text-muted-foreground">{t('partialNotice')}</p>
            ) : null}

            {filtered.groups.length === 0 ? (
              <Card className="p-6 text-center text-sm text-muted-foreground">{t('emptyStateTitle')}</Card>
            ) : (
              <div className="space-y-4">
                {filtered.groups.map((group) => (
                  <Card key={group.goalId} className="space-y-1 p-3">
                    <div className="flex items-center justify-between gap-2 px-1">
                      <h2 className="text-sm font-semibold text-foreground">{group.title}</h2>
                      <span className="text-xs text-muted-foreground">
                        {/* PO 지적(2026-09-14, 시안 재대조) — 「진행 중」 낱말은 GoalStatus==='active'
                            일 때만(데이터 없으면 지어내지 않는다). 기간 pill(예: 「이번 주」)은
                            target_date 기반 설계가 스코프 밖이라 PO 승인으로 생략. */}
                        {group.isActive ? `${t('stateInProgress')} · ` : ''}
                        {t('goalProgressLabel', { done: group.doneCount, total: group.totalCount })}
                      </span>
                    </div>
                    <div className="px-1 text-xs text-muted-foreground">
                      {t('goalSummaryLabel', { assigned: group.assignedCount, delegated: group.delegatedCount, hypotheses: group.hypothesisCount })}
                    </div>
                    {/* PO 지적(2026-09-14 08:12Z→08:28Z, 유나 픽셀 판정 — 시안 06d2d61c 재대조) —
                        스토리 절 머리는 회색 띠(bg-muted/30)가 아니라 굵은 제목 + 왼쪽 accent
                        border로: 목표→스토리→일 3단 위계가 회색 띠에서 눌렸다. per-story Card를
                        걷고 목표 Card 하나 안에서 세로 선으로 스토리 구간을 나눈다(새 토큰 0).
                        08:28Z 정정: 세로 선은 primary(파랑)가 아니라 중립 border-border — 파랑은
                        「사람 손 필요/주 액션」 전용 자리라 순수 구조선엔 안 쓴다. */}
                    <div className="space-y-4 pt-1">
                      {group.stories.map((story) => (
                        <div key={story.storyId} className="border-l-2 border-border pl-3">
                          <div className="pb-1 text-sm font-semibold text-foreground">{story.title}</div>
                          {story.rows.map((row) => (
                            <WorkListRowView
                              key={row.id}
                              row={row}
                              isSelected={selectedRowId === row.id}
                              onSelect={(rowId) => setSelectedRowId(selectedRowId === rowId ? null : rowId)}
                            />
                          ))}
                        </div>
                      ))}
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </>
        ) : loadError ? (
          <Card className="p-6 text-center text-sm text-muted-foreground">
            {t('loadErrorTitle')}
            <Button type="button" variant="link" className="ml-2 h-auto p-0" onClick={() => setReloadNonce((n) => n + 1)}>
              ↻
            </Button>
          </Card>
        ) : (
          <div className="p-4 text-sm text-muted-foreground">…</div>
        )}
        </div>
        {/* 데스크톱 aside — use-mobile.ts 기존 lg(1024) 문턱 재사용(새 breakpoint 0). */}
        {detailPanel && !isMobile ? (
          <aside className="w-[360px] shrink-0 border-l border-border">
            {detailPanel}
          </aside>
        ) : null}
      </div>
      {/* 모바일 Sheet — detailPanel이 있을 때만 open. */}
      <Sheet open={!!detailPanel && isMobile} onOpenChange={(open) => { if (!open) setSelectedRowId(null); }}>
        <SheetContent side="right" className="w-full p-0 sm:max-w-sm">
          {detailPanel}
        </SheetContent>
      </Sheet>
    </>
  );
}
