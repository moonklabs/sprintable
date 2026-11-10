'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ListFilter } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { fetchWorkList, type FetchedWorkList } from './fetch-work-list';
import { filterWorkList, EMPTY_WORK_LIST_FILTERS, type WorkListFilters } from './filter-work-list';
import { UNASSIGNED_GOAL_ID, UNLISTED_GOAL_ID } from './derive-work-list';
import { GoalGroupView } from './work-list-goal-group';
import { EmptyState } from '@/components/ds/empty-state';
import { useWorkListSelection } from './use-work-list-selection';
import { WorkListDetailPanel } from './work-list-detail-panel';
import { findSelectedRowContext, isRowVisibleInFiltered } from './work-list-detail-actions';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
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

/**
 * story #4456 — where the detail panel sits (the desktop aside or the mobile sheet). It adopts the one host node the panel is
 * rendered into, so crossing the 1024 px breakpoint moves the panel's DOM without mounting it again: what the person was doing
 * (the «근거 확인» check · the chosen tab · the gate already read) stays. Adopted in a layout effect — before the sheet's focus
 * trap looks for the first field — and given back on unmount (the other slot adopts it in the same commit).
 * story #4462 ⓐ (Kadir 09:14Z): adopted whenever the slot becomes the one in use (`active`), not only when it mounts — the sheet
 * stays mounted while its closing transition plays, so crossing the width back during it found the sheet's slot already mounted:
 * it never adopted the host again after the aside gave it back, and the sheet opened empty.
 */
function DetailPanelSlot({ host, active = true }: { host: HTMLElement | null; active?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const slot = ref.current;
    if (!slot || !host || !active) return;
    slot.appendChild(host);
    return () => { if (host.parentNode === slot) slot.removeChild(host); };
  }, [host, active]);
  return <div ref={ref} className="contents" />;
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
  const goalOptions = useMemo(
    () => data?.groups.map((g) => ({ id: g.goalId, label: g.goalId === UNASSIGNED_GOAL_ID ? t('unassignedGoalTitle') : g.goalId === UNLISTED_GOAL_ID ? t('unlistedGoalTitle') : g.title })) ?? [],
    [data, t],
  );
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
  // story #3934 AC3 — 필터가 걸린 채 groups가 0개면 "필터에 안 걸림"이지 "일로 안 쪼개짐"이
  // 아니다. 필터 무관(EMPTY_WORK_LIST_FILTERS)일 때만 task-0 전용 문구를 쓴다.
  const hasActiveFilters = filters.goalId !== EMPTY_WORK_LIST_FILTERS.goalId
    || filters.hypothesisId !== EMPTY_WORK_LIST_FILTERS.hypothesisId
    || filters.mineOnly !== EMPTY_WORK_LIST_FILTERS.mineOnly
    || filters.delegatedOnly !== EMPTY_WORK_LIST_FILTERS.delegatedOnly;

  // story #3845(우패널) 픽셀 커밋 ①(페드루 PO 판정 2026-09-14 09:11Z) — "URL이 SSOT":
  // 선택된 rowId는 data(필터 前 전체 트리)에서 찾는다 — filtered(화면에 보이는 목록)만
  // 보면 필터로 걸러진 행을 ?row= 딥링크로 열었을 때 패널이 아예 안 뜨는 결함이 난다
  // (「목록에 안 보이면 패널도 없다」는 URL은 선택했는데 화면은 무를 못 쓰는 모순 — PO가
  // 명시로 뒤집었다). isHiddenByFilter는 별도 축 — 패널이 뜨느냐(data 기준)와 화면에도
  // 보이느냐(filtered 기준)는 다른 질문이라 findSelectedRowContext/isRowVisibleInFiltered
  // 둘로 나눴다(work-list-detail-actions.ts, 순수함수라 테스트도 따로).
  const selectedContext = findSelectedRowContext(data, selectedRowId);
  const isHiddenByFilter = !!selectedContext && !isRowVisibleInFiltered(filtered, selectedContext.row.id);

  // story #4456 — one host node for the panel for the life of the shell (client only — the panel is never server-rendered).
  const [panelHost] = useState<HTMLElement | null>(() => {
    if (typeof document === 'undefined') return null;
    const el = document.createElement('div');
    el.className = 'contents';
    return el;
  });

  const detailPanel = selectedContext ? (
    <WorkListDetailPanel
      row={selectedContext.row}
      storyId={selectedContext.storyId}
      storyTitle={selectedContext.storyTitle}
      goalTitle={selectedContext.goalTitle}
      onClose={() => setSelectedRowId(null)}
      isHiddenByFilter={isHiddenByFilter}
      onClearFilters={() => setFilters({ goalId: null, hypothesisId: null, mineOnly: false, delegatedOnly: false })}
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
              <EmptyState
                icon="inbox"
                title={hasActiveFilters ? t('emptyStateFilteredTitle') : t('emptyStateTitle')}
                description={hasActiveFilters ? t('emptyStateFilteredHint') : undefined}
              />
            ) : (
              <div className="space-y-4" data-testid="work-list-groups">
                {filtered.groups.map((group) => (
                  <GoalGroupView
                    key={group.goalId}
                    group={group}
                    selectedRowId={selectedRowId}
                    onSelect={(rowId) => setSelectedRowId(selectedRowId === rowId ? null : rowId)}
                  />
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
          // [SID:4369] Esc 규칙의 층 뿌리 — 여러 줄 칸에서 빠져나온 초점이 여기로(tabIndex=-1).
          <aside data-work-list-detail="" tabIndex={-1} className="w-[360px] shrink-0 border-l border-border outline-none">
            <DetailPanelSlot host={panelHost} />
          </aside>
        ) : null}
      </div>
      {/* 모바일 Sheet — detailPanel이 있을 때만 open.
          [SID:4374] 닫기는 하나 — 안쪽 상세 패널 머리의 «닫기»(선택 해제 → open 거짓 → 시트도 닫힘)만 남기고 시트 기본 «✕»(절대 위치 · 같은 자리)는 끈다.
          Esc 한 번 = 같은 동작(시트 onOpenChange(false) → 선택 해제). 1440 aside는 이 시트를 안 거쳐 그대로.
          창 접근 이름 = 열린 항목 제목(화면 읽기 전용 SheetTitle → 창 aria-labelledby · 보이는 제목은 패널 머리 h2) · 제목이 비면 페이지 이름. */}
      <Sheet open={!!detailPanel && isMobile} onOpenChange={(open) => { if (!open) setSelectedRowId(null); }}>
        <SheetContent side="right" className="w-full p-0 sm:max-w-sm" showCloseButton={false}>
          {/* story #4386 — 선택이 비는 순간에도 창 이름이 남게 늘 그린다(제목이 비면 페이지 이름 — 위 주석 그대로). */}
          <SheetTitle className="sr-only">{selectedContext?.row.title || t('title')}</SheetTitle>
          {detailPanel ? <DetailPanelSlot host={panelHost} active={isMobile} /> : null}
        </SheetContent>
      </Sheet>
      {/* story #4456 — the panel itself, rendered once at this fixed place into the host node a slot above has adopted */}
      {detailPanel && panelHost ? createPortal(detailPanel, panelHost) : null}
    </>
  );
}
