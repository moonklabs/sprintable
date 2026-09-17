/**
 * story #4014(유나 시안 7c197474 §2·§4·보강) — 좁은 폭(390·768)에서 마케팅 목록 표 3곳
 * (블로그 포스트·채널 포스트·성과 보드)이 열 압착으로 한글 세로 쪼개짐·잘림 나던 것의
 * 공용 처방. 열 정의 하나로 두 폭을 그린다: ≥1024(`lg`)는 현행 `<table>` 마크업 그대로
 * (1440 스냅샷 무변 = 회귀 0) · <1024는 카드 리스트(캘린더 카드 선례,
 * `channel-post-card.tsx`와 동형 토큰 — 시안이 적은 `border-border/80 bg-card rounded-lg`는
 * 실 코드와 달라 실 코드 쪽을 따름).
 *
 * 🚨전환은 CSS 브레이크포인트로만(표·카드 둘 다 항상 DOM에 있고 Tailwind `lg:` 토글) —
 * `useIsMobile()` 같은 JS 훅을 구조 전환의 단독 게이트로 쓰면 SSR/하이드레이션 前엔 표가
 * 먼저 그려졌다 카드로 튀는 흔들림이 생긴다(AC5/AC6, 시안 §2 明示). 표 감싸개
 * `hidden lg:block` · 카드 감싸개 `lg:hidden`.
 *
 * 셀 내용은 화면마다 조건부 로직을 품는다(버튼·드롭다운·배지 다중 조합) — 순수 선언형
 * config(문자열/불리언만)로는 부족해 `renderCell`(표)·`renderCard`(카드, 생략 시 renderCell
 * 재사용) 둘 다 렌더 함수로 받는다. AC1의 "표를 손으로 안 짠다" 취지는 각 화면 page.tsx가
 * `<table>` JSX를 더 이상 직접 조립하지 않는다는 뜻이지, 셀 내용까지 이 컴포넌트가 지어낸다는
 * 뜻이 아니다(그러면 화면마다 다른 실 데이터·액션을 못 담는다).
 *
 * metric 슬롯 라벨(카드 라벨-값 그리드)은 별도 prop이 아니라 그 열의 `header`(표 `<th>`와
 * 같은 값)를 그대로 쓴다 — 성과 보드의 지표 라벨이 고정 문구가 아니라 지표 선택기로 바뀌는
 * 값이라(`{t('columnD1')} {metricLabel}`류), 표·카드가 다른 문구를 쓰면 한쪽만 바뀌어
 * 드리프트한다(유나 CHANGES 2026-09-17: "표 머리글과 같은 열 정의의 header에서").
 *
 * 그룹 헤더·행 footer(성과 보드 전용, 유나 CHANGES (가)(나)): `groupKey`로 연속 행을
 * 묶고 그 경계에 `renderGroupHeader`(표=그 그룹 첫 행 앞 <tr>·카드=그 그룹 카드 묶음 앞
 * 섹션 헤더, 둘 다 반환)를 끼운다. `renderRowFooter`는 각 데이터 행에 붙는 보조 내용
 * (재조정 결과류) — 표는 별도 <tr>(콜스팬)·카드는 그 카드 안쪽 맨 아래 footer로 다르게
 * 배치되므로 둘 다 명시로 받는다(하나가 없으면 그 형태엔 아무것도 안 붙임).
 */
import { Fragment, type ReactNode } from 'react';
import { Card } from '@/components/ui/card';

export interface ResponsiveDataTableColumn<T> {
  key: string;
  /** 표(≥1024) `<th>` 내용 — metric 슬롯이면 카드 라벨도 이 값을 그대로 쓴다(단일 정본). */
  header: ReactNode;
  /** 표 `<th>` className 추가분(폭 등) — 표 마크업 무변 유지를 위해 화면별로 기존 값 그대로 넘긴다. */
  headerClassName?: string;
  /** 표 `<td>` className 추가분. */
  cellClassName?: string;
  /** 카드(<1024) 모드에서 이 열이 어느 자리에 놓이는가. 'hidden'은 카드에서 아예 안 그림
   * (표 전용 열 — 예: 화면들의 액션 열은 title 슬롯과 별개로 카드 우상단에 직접 배치). */
  cardSlot: 'title' | 'meta' | 'metric' | 'action' | 'hidden';
  /** 표 `<td>` 내용. */
  renderCell: (row: T, index: number) => ReactNode;
  /** 카드 내용 — 생략하면 renderCell을 그대로 재사용. */
  renderCard?: (row: T, index: number) => ReactNode;
}

export interface ResponsiveDataTableRenderedPair {
  /** 표 쪽에 그대로 끼워 넣을 `<tr>` 완성 노드(콜스팬 등 화면이 직접 구성). */
  table: ReactNode;
  /** 카드 쪽에 끼워 넣을 내용(섹션 헤더 또는 카드 내부 footer, 화면이 직접 구성). */
  card: ReactNode;
}

export interface ResponsiveDataTableProps<T> {
  columns: ResponsiveDataTableColumn<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string;
  /** 표 `<tr>`·카드 둘 다에 실리는 data-testid(행 구분용, 화면별 기존 관례 보존). */
  rowTestId?: string;
  /** 표 전체를 감싸는 `<table>`의 className 추가분(기존 `w-full text-sm` 뒤에 이어붙임). */
  tableClassName?: string;
  /** 표 `<thead>` className. */
  theadClassName?: string;
  /** 표 `<tbody>` className. */
  tbodyClassName?: string;
  /** 연속 행을 그룹으로 묶는 키. null이면 그 행 앞엔 그룹 헤더를 안 넣는다. rows는 이미
   * 그룹 순서대로 정렬돼 들어온다고 가정(재정렬 안 함). */
  groupKey?: (row: T, index: number) => string | null;
  /** 그룹 경계(새 groupKey 등장)마다 그 그룹의 첫 행 호출 시점에 한 번 불린다. */
  renderGroupHeader?: (row: T, index: number, key: string) => ResponsiveDataTableRenderedPair;
  /** 각 데이터 행에 붙는 보조 내용(재조정 결과류) — null/undefined 반환 시 그 행엔 안 붙임. */
  renderRowFooter?: (row: T, index: number) => ResponsiveDataTableRenderedPair | null;
}

const CARD_WRAPPER_CLASS = 'block space-y-1.5 rounded-md border border-border p-2 text-xs';

export function ResponsiveDataTable<T>({
  columns,
  rows,
  rowKey,
  rowTestId,
  tableClassName,
  theadClassName,
  tbodyClassName,
  groupKey,
  renderGroupHeader,
  renderRowFooter,
}: ResponsiveDataTableProps<T>) {
  const titleColumns = columns.filter((c) => c.cardSlot === 'title');
  const metaColumns = columns.filter((c) => c.cardSlot === 'meta');
  const metricColumns = columns.filter((c) => c.cardSlot === 'metric');
  const actionColumns = columns.filter((c) => c.cardSlot === 'action');

  let lastGroupKey: string | null = null;

  return (
    <>
      {/* ≥1024 — 현행 표 마크업(1440 스냅샷 무변). */}
      <Card className="hidden overflow-hidden p-0 lg:block">
        <table className={`w-full text-sm${tableClassName ? ` ${tableClassName}` : ''}`}>
          <thead className={theadClassName ?? 'bg-muted/50 text-xs text-muted-foreground'}>
            <tr>
              {columns.map((col) => (
                <th key={col.key} className={col.headerClassName ?? 'px-3 py-2 text-left font-medium'}>
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className={tbodyClassName ?? 'divide-y divide-border'}>
            {rows.map((row, index) => {
              const key = groupKey?.(row, index) ?? null;
              const isNewGroup = key !== null && key !== lastGroupKey;
              if (isNewGroup) lastGroupKey = key;
              const groupHeaderPair = isNewGroup ? renderGroupHeader?.(row, index, key) : undefined;
              const footerPair = renderRowFooter?.(row, index);
              return (
                <Fragment key={rowKey(row, index)}>
                  {groupHeaderPair ? groupHeaderPair.table : null}
                  <tr data-testid={rowTestId}>
                    {columns.map((col) => (
                      <td key={col.key} className={col.cellClassName ?? 'px-3 py-2.5'}>
                        {col.renderCell(row, index)}
                      </td>
                    ))}
                  </tr>
                  {footerPair ? footerPair.table : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </Card>

      {/* <1024 — 카드 리스트(시안 §3). */}
      <div className="space-y-2 lg:hidden" data-testid="responsive-data-table-cards">
        {(() => {
          lastGroupKey = null;
          return rows.map((row, index) => {
            const key = groupKey?.(row, index) ?? null;
            const isNewGroup = key !== null && key !== lastGroupKey;
            if (isNewGroup) lastGroupKey = key;
            const groupHeaderPair = isNewGroup ? renderGroupHeader?.(row, index, key) : undefined;
            const footerPair = renderRowFooter?.(row, index);
            return (
              <div key={rowKey(row, index)}>
                {groupHeaderPair ? <div>{groupHeaderPair.card}</div> : null}
                <div className={CARD_WRAPPER_CLASS} data-testid={rowTestId}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1 space-y-1">
                      {titleColumns.map((col) => (
                        <div key={col.key} className="line-clamp-2 font-medium text-foreground">
                          {(col.renderCard ?? col.renderCell)(row, index)}
                        </div>
                      ))}
                      {metaColumns.length > 0 ? (
                        <div className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
                          {metaColumns.map((col) => (
                            <span key={col.key} className="inline-flex items-center gap-1">
                              {(col.renderCard ?? col.renderCell)(row, index)}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                    {actionColumns.length > 0 ? (
                      <div className="flex shrink-0 items-center gap-1">
                        {actionColumns.map((col) => (
                          <span key={col.key}>{(col.renderCard ?? col.renderCell)(row, index)}</span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  {metricColumns.length > 0 ? (
                    <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 border-t border-border pt-1.5">
                      {metricColumns.map((col) => (
                        <div key={col.key} className="space-y-0.5">
                          <p className="text-[11px] text-muted-foreground">{col.header}</p>
                          <div className="font-medium text-foreground">{(col.renderCard ?? col.renderCell)(row, index)}</div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {footerPair ? footerPair.card : null}
                </div>
              </div>
            );
          });
        })()}
      </div>
    </>
  );
}
