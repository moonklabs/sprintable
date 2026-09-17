// @vitest-environment jsdom
//
// story #4014 — ResponsiveDataTable 공용 컴포넌트 pin.
// AC5/AC6(첫 렌더 흔들림 0)의 핵심 계약: 표·카드 DOM이 항상 둘 다 있고 Tailwind
// `hidden lg:block`/`lg:hidden`만으로 토글된다(JS 훅으로 조건부 마운트하면 SSR/
// 하이드레이션 前 표가 먼저 그려졌다 카드로 튀는 흔들림이 생긴다 — 그래서 "항상 둘 다
// DOM에 있다"를 직접 단언한다, mount/unmount 토글이 아니라 클래스 토글임을 pin).
import { describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ResponsiveDataTable, type ResponsiveDataTableColumn } from './responsive-data-table';

interface Row { id: string; title: string; status: string; }

const ROWS: Row[] = [
  { id: 'r-1', title: '첫 번째 글', status: '승인됨' },
  { id: 'r-2', title: '두 번째 글', status: '초안' },
];

const COLUMNS: ResponsiveDataTableColumn<Row>[] = [
  { key: 'title', header: '제목', cardSlot: 'title', renderCell: (r) => r.title },
  { key: 'status', header: '상태', cardSlot: 'meta', renderCell: (r) => r.status },
  {
    key: 'action', header: '', cardSlot: 'action',
    renderCell: () => <button type="button" data-testid="row-action">⋯</button>,
  },
];

function mountTable() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  return { container, root };
}

describe('ResponsiveDataTable', () => {
  it('⭐표·카드 DOM이 항상 둘 다 있고 hidden lg:block/lg:hidden 클래스로만 토글된다(AC5/6)', async () => {
    const { container, root } = mountTable();
    await act(async () => {
      root.render(<ResponsiveDataTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} />);
    });

    const table = container.querySelector('table');
    expect(table).not.toBeNull();
    // 표 감싸개(Card)는 hidden lg:block — mount 자체가 아니라 class 토글임을 pin.
    const tableWrapper = table!.closest('[class*="hidden"]');
    expect(tableWrapper).not.toBeNull();
    expect(tableWrapper!.className).toContain('hidden');
    expect(tableWrapper!.className).toContain('lg:block');

    const cardWrapper = container.querySelector('[data-testid="responsive-data-table-cards"]');
    expect(cardWrapper).not.toBeNull();
    expect(cardWrapper!.className).toContain('lg:hidden');
    // 카드 wrapper엔 무조건 hidden이 없어야 한다(JS 조건부 마운트로 오인되지 않게 — 항상
    // DOM에 있고 lg:hidden 하나로만 좁혀지는 계약).
    expect(cardWrapper!.className).not.toContain(' hidden');

    await act(async () => { root.unmount(); });
    container.remove();
  });

  it('⭐표·카드 둘 다 같은 행 데이터를 담는다(행 수 일치, 흔들림 전환 시 내용 불일치 없음)', async () => {
    const { container, root } = mountTable();
    await act(async () => {
      root.render(<ResponsiveDataTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} />);
    });

    const tableRows = container.querySelectorAll('table tbody tr');
    const cardRows = container.querySelectorAll('[data-testid="responsive-data-table-cards"] > div');
    expect(tableRows.length).toBe(ROWS.length);
    expect(cardRows.length).toBe(ROWS.length);
    expect(container.textContent).toContain('첫 번째 글');
    expect(container.textContent).toContain('두 번째 글');

    await act(async () => { root.unmount(); });
    container.remove();
  });

  it('⭐cardSlot별 배치 — title은 line-clamp-2, action은 우상단, meta는 부제 줄', async () => {
    const { container, root } = mountTable();
    await act(async () => {
      root.render(<ResponsiveDataTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} />);
    });

    const firstCard = container.querySelectorAll('[data-testid="responsive-data-table-cards"] > div')[0];
    const titleEl = firstCard.querySelector('.line-clamp-2');
    expect(titleEl?.textContent).toBe('첫 번째 글');
    expect(firstCard.querySelector('[data-testid="row-action"]')).not.toBeNull();
    expect(firstCard.textContent).toContain('승인됨');

    await act(async () => { root.unmount(); });
    container.remove();
  });

  it('⭐metric 슬롯은 라벨-값 2열 그리드로 렌더된다(라벨=header, 별도 라벨 prop 없음)', async () => {
    const metricColumns: ResponsiveDataTableColumn<Row>[] = [
      ...COLUMNS,
      { key: 'm1', header: '발행 다음날 조회', cardSlot: 'metric', renderCell: () => '1,240' },
      { key: 'm2', header: '발행 7일 뒤 조회', cardSlot: 'metric', renderCell: () => '3,880' },
    ];
    const { container, root } = mountTable();
    await act(async () => {
      root.render(<ResponsiveDataTable columns={metricColumns} rows={ROWS} rowKey={(r) => r.id} />);
    });

    const firstCard = container.querySelectorAll('[data-testid="responsive-data-table-cards"] > div')[0];
    const grid = firstCard.querySelector('.grid.grid-cols-2');
    expect(grid).not.toBeNull();
    expect(grid!.textContent).toContain('발행 다음날 조회');
    expect(grid!.textContent).toContain('1,240');
    expect(grid!.textContent).toContain('발행 7일 뒤 조회');
    expect(grid!.textContent).toContain('3,880');

    await act(async () => { root.unmount(); });
    container.remove();
  });

  it('⭐renderCard가 있으면 카드 모드에서 renderCell 대신 그것을 쓴다', async () => {
    const columns: ResponsiveDataTableColumn<Row>[] = [
      {
        key: 'title', header: '제목', cardSlot: 'title',
        renderCell: (r) => `표: ${r.title}`,
        renderCard: (r) => `카드: ${r.title}`,
      },
    ];
    const { container, root } = mountTable();
    await act(async () => {
      root.render(<ResponsiveDataTable columns={columns} rows={ROWS} rowKey={(r) => r.id} />);
    });

    expect(container.querySelector('table')!.textContent).toContain('표: 첫 번째 글');
    expect(container.querySelector('[data-testid="responsive-data-table-cards"]')!.textContent).toContain('카드: 첫 번째 글');

    await act(async () => { root.unmount(); });
    container.remove();
  });

  // story #4014 CHANGES(유나 2026-09-17, 성과 보드 그룹 헤더·재조정 결과) — 표 쪽은
  // 별도 <tr>(그룹 헤더는 그 그룹 첫 행 앞, footer는 그 행 바로 뒤) · 카드 쪽은 그룹
  // 헤더=카드 묶음 앞 섹션 헤더·footer=그 카드 안쪽 맨 아래.
  it('⭐groupKey·renderGroupHeader — 그룹 경계마다 표엔 앞선 <tr>·카드엔 앞선 섹션 헤더', async () => {
    const groupedRows: Row[] = [
      { id: 'r-1', title: 'A그룹 글1', status: '승인됨' },
      { id: 'r-2', title: 'A그룹 글2', status: '초안' },
      { id: 'r-3', title: 'B그룹 글1', status: '승인됨' },
    ];
    const groupOf = (r: Row) => (r.title.startsWith('A그룹') ? 'A' : 'B');
    const { container, root } = mountTable();
    await act(async () => {
      root.render(
        <ResponsiveDataTable
          columns={COLUMNS}
          rows={groupedRows}
          rowKey={(r) => r.id}
          groupKey={(r) => groupOf(r)}
          renderGroupHeader={(r, _i, key) => ({
            table: <tr data-testid="group-header-row"><td colSpan={COLUMNS.length}>그룹 {key}</td></tr>,
            card: <p data-testid="group-header-card">그룹 {key}</p>,
          })}
        />,
      );
    });

    // 표: 그룹 헤더 <tr>이 정확히 그룹 수(2)만큼, 각 그룹의 첫 행 바로 앞에.
    const tableGroupHeaders = container.querySelectorAll('table [data-testid="group-header-row"]');
    expect(tableGroupHeaders).toHaveLength(2);
    const tbodyRows = [...container.querySelectorAll('table tbody > *')];
    // A그룹 헤더 → A그룹 글1 행 순서(연속 같은 그룹 내 두 번째 행 앞엔 헤더 없음).
    const groupHeaderIdx = tbodyRows.findIndex((el) => el.getAttribute('data-testid') === 'group-header-row');
    expect(tbodyRows[groupHeaderIdx + 1]?.textContent).toContain('A그룹 글1');

    // 카드: 섹션 헤더도 정확히 그룹 수(2)만큼.
    const cardGroupHeaders = container.querySelectorAll('[data-testid="group-header-card"]');
    expect(cardGroupHeaders).toHaveLength(2);

    await act(async () => { root.unmount(); });
    container.remove();
  });

  it('⭐renderRowFooter — 표는 별도 <tr>·카드는 그 카드 안쪽 footer로 다르게 배치', async () => {
    const { container, root } = mountTable();
    await act(async () => {
      root.render(
        <ResponsiveDataTable
          columns={COLUMNS}
          rows={[ROWS[0]]}
          rowKey={(r) => r.id}
          renderRowFooter={(r) => ({
            table: <tr data-testid="row-footer-row"><td colSpan={COLUMNS.length}>재조정: {r.title}</td></tr>,
            card: <p data-testid="row-footer-card" className="border-t mt-2 pt-2 text-xs">재조정: {r.title}</p>,
          })}
        />,
      );
    });

    // 표: footer가 데이터 행과 형제인 별도 <tr>(같은 카드 안이 아님 — table엔 카드 개념 없음).
    const footerTr = container.querySelector('table [data-testid="row-footer-row"]');
    expect(footerTr).not.toBeNull();
    expect(footerTr!.tagName).toBe('TR');

    // 카드: footer가 그 행의 카드 wrapper(border rounded-md) 안쪽에 있다(형제 카드가 아님).
    const cardWrapper = container.querySelector('[data-testid="responsive-data-table-cards"] .rounded-md.border');
    expect(cardWrapper).not.toBeNull();
    expect(cardWrapper!.querySelector('[data-testid="row-footer-card"]')).not.toBeNull();

    await act(async () => { root.unmount(); });
    container.remove();
  });

  // story #4014 — insights-board의 스크롤-투-로우 딥링크(rowRefs)가 <tr>/카드 wrapper
  // DOM 노드 참조와 className(하이라이트 배경)을 직접 잡아야 해서 만든 탈출구.
  it('⭐getRowProps — ref·className이 표 <tr>·카드 wrapper 둘 다에 실린다', async () => {
    const refs: HTMLElement[] = [];
    const { container, root } = mountTable();
    await act(async () => {
      root.render(
        <ResponsiveDataTable
          columns={COLUMNS}
          rows={[ROWS[0]]}
          rowKey={(r) => r.id}
          getRowProps={() => ({
            ref: (el) => { if (el) refs.push(el); },
            className: 'bg-primary/10',
          })}
        />,
      );
    });

    const tr = container.querySelector('table tbody tr');
    expect(tr!.className).toContain('bg-primary/10');
    const cardWrapper = container.querySelector('[data-testid="responsive-data-table-cards"] .rounded-md.border');
    expect(cardWrapper!.className).toContain('bg-primary/10');
    // ref 콜백이 표·카드 두 실 DOM 노드 모두에서 호출됐다(항상 둘 다 DOM에 있다는
    // AC5/6 계약과 정합 — 하나만 마운트되면 refs.length===1이었을 것).
    expect(refs.length).toBe(2);

    await act(async () => { root.unmount(); });
    container.remove();
  });
});
