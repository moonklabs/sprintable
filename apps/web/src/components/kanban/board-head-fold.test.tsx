// @vitest-environment jsdom
//
// story #4923 — 보드 머리 접기: 순수 판정 · 훅(폭 측정) · 접힌 단추 + 팝오버.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { HEAD_GAP_PX, HeadFilterFold, mayUnfold, needsFold, useHeadFold } from './board-head-fold';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('[SID:4923] 접기 판정(순수)', () => {
  it('펼친 머리가 필요로 하는 폭이 머리 폭을 넘을 때만 접는다(서브픽셀 0.5 허용)', () => {
    expect(needsFold(985, 748)).toBe(true);
    expect(needsFold(985, 1088)).toBe(false);
    expect(needsFold(748.4, 748)).toBe(false);
    expect(needsFold(749, 748)).toBe(true);
  });
  it('다시 펼치는 것은 머리 폭이 «펼쳤을 때 필요한 폭» 이상이 된 뒤다(접었다 폈다 깜빡이지 않게 같은 값으로 가른다)', () => {
    expect(mayUnfold(985, 984)).toBe(false);
    expect(mayUnfold(985, 985)).toBe(true);
    expect(mayUnfold(985, 1088)).toBe(true);
    // 접는 선과 펴는 선이 같은 값이라 사이 구간이 없다
    for (const w of [900, 984, 985, 986, 1100]) expect(needsFold(985, w) && mayUnfold(985, w)).toBe(false);
  });
});

// ── 훅: 실제 DOM 폭은 jsdom에 없으니 폭을 직접 주고 ResizeObserver를 손으로 부른다 ──
let container: HTMLDivElement;
let root: Root;
let observers: Array<() => void> = [];
let width = 748;
let desktop = true;
const WIDTHS: Record<string, number> = { a: 241, b: 1, c: 460, d: 259 };
afterEach(() => { WIDTHS.c = 460; });

beforeEach(() => {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  observers = []; width = 748; desktop = true;
  vi.stubGlobal('ResizeObserver', class { cb: () => void; constructor(cb: () => void) { this.cb = cb; observers.push(cb); } observe() {} disconnect() { observers = observers.filter((o) => o !== this.cb); } });
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('1024') ? desktop : false, addEventListener() {}, removeEventListener() {} }));
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return WIDTHS[(this as HTMLElement).getAttribute('data-w') ?? ''] ?? 0; } });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return (this as HTMLElement).getAttribute('data-testid') === 'head' ? width : 0; } });
});
afterEach(async () => {
  await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals();
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetWidth; delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
});

function Probe({ keyStr = 'k' }: { keyStr?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const folded = useHeadFold(ref, keyStr);
  return <div ref={ref} data-testid="head" data-folded={String(folded)}><i data-w="a" /><i data-w="b" /><i data-w="c" /><i data-w="d" /></div>;
}
const folded = () => (container.querySelector('[data-testid="head"]') as HTMLElement).getAttribute('data-folded');
const fire = async () => { await act(async () => { observers.forEach((o) => o()); }); };

describe('[SID:4923] useHeadFold — 폭으로 접는다', () => {
  it('⭐필요한 폭(자식 폭 합 + 간격 + 여백 = 241+1+460+259 + 3×gap)이 머리 폭 748을 넘으면 접히고, 1100이 되면 펴진다', async () => {
    await act(async () => { root.render(<Probe />); });
    expect(241 + 1 + 460 + 259 + 3 * HEAD_GAP_PX).toBe(985);
    expect(folded()).toBe('true');                  // 748 < 985
    width = 984; await fire();
    expect(folded()).toBe('true');                  // 아직 모자람
    width = 985; await fire();
    expect(folded()).toBe('false');                 // 딱 맞으면 편다
    width = 1088; await fire();
    expect(folded()).toBe('false');                 // 1440의 머리 폭
  });

  it('⭐내용이 바뀌면(contentKey) 접혀 있던 머리도 펼쳤을 때의 폭을 다시 재서 그에 맞게 편다 — 접힌 동안 잰 옛 값에 머물지 않는다', async () => {
    await act(async () => { root.render(<Probe keyStr="a" />); });
    expect(folded()).toBe('true');                  // 필요 985 > 748
    WIDTHS.c = 100;                                  // 거르기 묶음이 훨씬 좁아진 내용(예: 칩이 줄었다)
    await act(async () => { root.render(<Probe keyStr="b" />); });
    expect(folded()).toBe('false');                 // 필요 241+1+100+259+24 = 625 ≤ 748 → 펴진다(옛 값 985에 머물면 접힌 채)
    WIDTHS.c = 460;
    await act(async () => { root.render(<Probe keyStr="c" />); });
    expect(folded()).toBe('true');                  // 다시 넓어진 내용 → 접힌다
  });

  it('넉넉한 폭에서 시작하면 처음부터 펼친 채다', async () => {
    width = 1088;
    await act(async () => { root.render(<Probe />); });
    expect(folded()).toBe('false');
  });

  it('폰(lg 아래)은 폭이 좁아도 접지 않는다 — 폰은 원래 가로로 미는 한 줄', async () => {
    desktop = false;
    await act(async () => { root.render(<Probe />); });
    expect(folded()).toBe('false');
  });

  it('창 환경이 matchMedia · ResizeObserver를 몰라도 죽지 않고 펼친 채다(시험 · 옛 브라우저)', async () => {
    vi.stubGlobal('matchMedia', undefined); vi.stubGlobal('ResizeObserver', undefined);
    await act(async () => { root.render(<Probe />); });
    expect(folded()).toBe('false');
  });
});

describe('[SID:4923] HeadFilterFold — 접힌 단추 + 팝오버', () => {
  const props = { count: 0, label: '거르기', labelActive: '거르기 · 2', popoverLabel: '거르기 조건' };
  const kids = <><button type="button" data-testid="tab-all">전체</button><button type="button" data-testid="chip-sprint">전체 스프린트</button></>;
  const excluded = <span data-testid="excluded">숨긴 2</span>;

  it('펼친 상태: 조작이 줄 안에 그대로 서고(단추 없음) «숨긴 N»도 같이 있다', async () => {
    await act(async () => { root.render(<HeadFilterFold folded={false} {...props} excluded={excluded}>{kids}</HeadFilterFold>); });
    const g = container.querySelector('[data-slot="board-head-filters"]')!;
    expect(g.getAttribute('data-folded')).toBe('false');
    expect(g.querySelector('[data-testid="tab-all"]')).not.toBeNull();
    expect(g.querySelector('[data-testid="chip-sprint"]')).not.toBeNull();
    expect(g.querySelector('[data-testid="excluded"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="board-filter-fold"]')).toBeNull();
  });

  it('⭐접힌 상태: «거르기» 단추 하나만 서고 조작은 팝오버를 열기 전엔 DOM에 없다 · «숨긴 N»은 접히지 않는다', async () => {
    await act(async () => { root.render(<HeadFilterFold folded {...props} excluded={excluded}>{kids}</HeadFilterFold>); });
    const trigger = container.querySelector('[data-testid="board-filter-fold"]') as HTMLButtonElement;
    expect(trigger.textContent).toBe('거르기');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-testid="tab-all"]')).toBeNull();
    expect(container.querySelector('[data-testid="excluded"]')).not.toBeNull();
  });

  it('적용 중인 거르기가 있으면 단추 글이 «거르기 · n»이다', async () => {
    await act(async () => { root.render(<HeadFilterFold folded {...props} count={2}>{kids}</HeadFilterFold>); });
    expect(container.querySelector('[data-testid="board-filter-fold"]')!.textContent).toBe('거르기 · 2');
  });

  it('⭐누르면 이름 있는 팝오버가 열려 조작 전부가 들어 있고, Esc로 닫히며 초점이 단추로 돌아온다', async () => {
    await act(async () => { root.render(<HeadFilterFold folded {...props}>{kids}</HeadFilterFold>); });
    const trigger = container.querySelector('[data-testid="board-filter-fold"]') as HTMLButtonElement;
    await act(async () => { trigger.focus(); trigger.click(); });
    const pop = document.querySelector('[data-slot="board-filter-popover"]') as HTMLElement;
    expect(pop).not.toBeNull();
    expect(pop.getAttribute('aria-label')).toBe('거르기 조건');
    expect(pop.querySelector('[data-testid="tab-all"]')).not.toBeNull();
    expect(pop.querySelector('[data-testid="chip-sprint"]')).not.toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    await act(async () => { pop.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(document.querySelector('[data-slot="board-filter-popover"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
