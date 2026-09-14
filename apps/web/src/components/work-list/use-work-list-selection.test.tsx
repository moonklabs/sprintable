// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useWorkListSelection } from './use-work-list-selection';

// story #3845 — legacy-nav-ssot.test.tsx의 next/navigation mock 관례와 동형(usePathname·
// useSearchParams·useRouter 3종만). searchParamsRef를 router.replace가 직접 갱신 —
// 실 Next.js 라우팅 없이도 "URL이 SSOT"라는 이 훅의 계약(useWorkListFilters와 동일 원칙)을
// write→다음 render의 read가 그대로 돌려주는지로 잰다(work-list-row.test.tsx의 수동
// 재렌더 관례 — 이 스위트도 setState 자동재렌더에 기대지 않고 매번 명시적으로 다시 그린다).
const { searchParamsRef, replaceCalls } = vi.hoisted(() => ({
  searchParamsRef: { current: new URLSearchParams('') },
  replaceCalls: [] as string[],
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/work-list',
  useSearchParams: () => searchParamsRef.current,
  useRouter: () => ({
    replace: (url: string) => {
      replaceCalls.push(url);
      const qIndex = url.indexOf('?');
      searchParamsRef.current = new URLSearchParams(qIndex >= 0 ? url.slice(qIndex + 1) : '');
    },
  }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Harness() {
  const [selectedRowId, setSelectedRowId] = useWorkListSelection();
  return (
    <div>
      <div data-testid="selected">{selectedRowId ?? 'none'}</div>
      <button type="button" data-testid="select-a" onClick={() => setSelectedRowId('row-a')}>select a</button>
      <button type="button" data-testid="clear" onClick={() => setSelectedRowId(null)}>clear</button>
    </div>
  );
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  searchParamsRef.current = new URLSearchParams('');
  replaceCalls.length = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.restoreAllMocks();
});

function selectedText(): string | null {
  return container.querySelector('[data-testid="selected"]')?.textContent ?? null;
}

describe('useWorkListSelection', () => {
  it('초기 상태(?row= 없음)는 선택 없음', async () => {
    await act(async () => { root.render(<Harness />); });
    expect(selectedText()).toBe('none');
  });

  it('⭐URL 왕복 — 선택하면 router.replace가 ?row=<id>를 싣고, 다음 render가 그 값을 그대로 되읽는다', async () => {
    await act(async () => { root.render(<Harness />); });
    const btn = container.querySelector('[data-testid="select-a"]') as HTMLButtonElement;
    await act(async () => { btn.click(); });
    expect(replaceCalls.at(-1)).toBe('/work-list?row=row-a');

    // 새로고침을 흉내(같은 훅을 다시 마운트해 URL에서 복원) — useWorkListFilters와 동일
    // "URL이 SSOT" 계약의 핵심(useState 로컬 상태였다면 여기서 사라진다).
    await act(async () => { root.render(<Harness />); });
    expect(selectedText()).toBe('row-a');
  });

  it('페이지 로드 시 이미 ?row=<id>가 있으면 마운트 즉시 그 선택을 복원한다', async () => {
    searchParamsRef.current = new URLSearchParams('row=row-b');
    await act(async () => { root.render(<Harness />); });
    expect(selectedText()).toBe('row-b');
  });

  it('⭐Esc — 문서 전역 keydown으로 선택을 해제하고 URL에서 row를 지운다', async () => {
    searchParamsRef.current = new URLSearchParams('row=row-a');
    await act(async () => { root.render(<Harness />); });
    expect(selectedText()).toBe('row-a');

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(replaceCalls.at(-1)).toBe('/work-list');
    expect(searchParamsRef.current.get('row')).toBeNull();

    await act(async () => { root.render(<Harness />); });
    expect(selectedText()).toBe('none');
  });

  it('Esc 이외의 키는 선택을 건드리지 않는다(과다반응 방지 — 양성대조)', async () => {
    searchParamsRef.current = new URLSearchParams('row=row-a');
    await act(async () => { root.render(<Harness />); });
    const callsBefore = replaceCalls.length;

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    });
    expect(replaceCalls.length).toBe(callsBefore);
  });

  it('clear 버튼(명시 해제)도 Esc와 동일하게 URL에서 row를 지운다', async () => {
    searchParamsRef.current = new URLSearchParams('row=row-a&goal=g1');
    await act(async () => { root.render(<Harness />); });
    const btn = container.querySelector('[data-testid="clear"]') as HTMLButtonElement;
    await act(async () => { btn.click(); });
    // goal 필터 등 다른 쿼리 파라미터는 보존(row만 지운다 — URLSearchParams.toString()의
    // 기존 순서 보존 동작 그대로, 필터 상태와 선택 상태가 서로 안 지운다).
    expect(replaceCalls.at(-1)).toBe('/work-list?goal=g1');
  });
});
