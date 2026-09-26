// @vitest-environment jsdom
//
// story #4349 — AnchoredPopover: 트리거에 붙는 팝오버를 부모 overflow 밖(body)에 fixed로 그린다.
// jsdom은 배치를 안 해서 트리거 · 팝오버 사각형을 값으로 둔다(뷰포트 1024).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AnchoredPopover, placeVertical } from './anchored-popover';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let anchorRect = { left: 100, right: 180, top: 40, bottom: 60 };
let popRect = { left: 100, right: 324 }; // 224px

beforeEach(() => {
  anchorRect = { left: 100, right: 180, top: 40, bottom: 60 };
  popRect = { left: 100, right: 324 };
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const r = this.id === 'anchor' ? { ...anchorRect, width: anchorRect.right - anchorRect.left, height: 20 }
      : this.id === 'pop' ? { ...popRect, top: 0, bottom: 80, width: popRect.right - popRect.left, height: 80 }
        : { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };
    return { ...r, x: r.left, y: r.top, toJSON: () => r } as DOMRect;
  });
  container = document.createElement('div');
  container.className = 'overflow-hidden';
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.restoreAllMocks();
});

// 트리거 wrapper의 ref가 **열릴 때만** 붙는 호출부 모양(축척 사다리와 같음) — 자식 ref가 먼저 붙는 순서를 그대로 재현한다.
function Harness({ offsetX, initiallyOpen = false, align }: { offsetX?: number; initiallyOpen?: boolean; tick?: number; align?: 'start' | 'end' }) {
  const [open, setOpen] = useState(initiallyOpen);
  const anchorRef = useRef<HTMLDivElement>(null);
  return (
    <div className="flex overflow-x-auto">
      <div id="anchor" ref={open ? anchorRef : undefined} className="relative">
        <button type="button" id="trigger" onClick={() => setOpen((v) => !v)}>열기</button>
        {open && <AnchoredPopover anchorRef={anchorRef} offsetX={offsetX} align={align} id="pop" role="tooltip" className="w-56">안내</AnchoredPopover>}
      </div>
    </div>
  );
}

const pop = () => document.getElementById('pop')!;

describe('AnchoredPopover(story #4349)', () => {
  it('body 직속 · fixed · 트리거 아래 8px · 트리거 왼쪽 + offsetX · 드러남(visibility)', () => {
    act(() => { root.render(<Harness offsetX={12} />); });
    act(() => { document.getElementById('trigger')!.click(); });
    expect(pop().parentElement).toBe(document.body);
    expect(container.contains(pop())).toBe(false);
    expect(pop().style.position).toBe('fixed');
    expect(pop().style.top).toBe('68px');
    expect(pop().style.left).toBe('112px');
    expect(pop().style.visibility).toBe('');
  });

  it('뷰포트 오른쪽으로 넘치면 여백 8px까지 translateX로 민다(4342 viewportShiftX)', () => {
    popRect = { left: 900, right: 1124 };
    act(() => { root.render(<Harness />); });
    act(() => { document.getElementById('trigger')!.click(); });
    expect(pop().style.transform).toBe('translateX(-108px)');
  });

  it('어느 조상이든 스크롤되면(capture) · 창 크기가 바뀌면 트리거 새 자리로 다시 둔다', () => {
    act(() => { root.render(<Harness />); });
    act(() => { document.getElementById('trigger')!.click(); });
    anchorRect = { left: 40, right: 120, top: 40, bottom: 60 }; // 칩 줄 가로 스크롤로 트리거가 왼쪽으로
    act(() => { container.firstElementChild!.dispatchEvent(new Event('scroll')); });
    expect(pop().style.left).toBe('40px');
    anchorRect = { left: 10, right: 90, top: 140, bottom: 160 };
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(pop().style.left).toBe('10px');
    expect(pop().style.top).toBe('168px');
  });

  it('닫히면 body에서 사라지고 듣기를 푼다', () => {
    act(() => { root.render(<Harness />); });
    act(() => { document.getElementById('trigger')!.click(); });
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    act(() => { document.getElementById('trigger')!.click(); });
    expect(document.getElementById('pop')).toBeNull();
    expect(removeSpy.mock.calls.some(([type, , capture]) => type === 'scroll' && capture === true)).toBe(true);
  });

  // 뮤테이션 A1(포털 대상을 «트리거 ?? body»로)이 첫 판에서 살아남았다 — 첫 렌더엔 트리거 ref가 아직 없어 body로 떨어지기 때문.
  // 열린 뒤 **다시 그려도**(부모 상태 · props 바뀜) 늘 body 직속이어야 한다(그때 트리거 안으로 옮겨 가면 부모 띠가 다시 자른다).
  it('열린 뒤 다시 그려져도 늘 body 직속(부모 안으로 옮겨 가지 않음)', () => {
    act(() => { root.render(<Harness />); });
    act(() => { document.getElementById('trigger')!.click(); });
    act(() => { root.render(<Harness tick={1} />); });
    act(() => { root.render(<Harness tick={2} />); });
    expect(pop().parentElement).toBe(document.body);
    expect(container.contains(pop())).toBe(false);
  });

  it('처음부터 열린 채 붙어도(트리거 ref가 자식보다 늦게 붙는 순서) 제자리에 드러난다', () => {
    act(() => { root.render(<Harness initiallyOpen />); });
    expect(pop().style.visibility).toBe('');
    expect(pop().style.top).toBe('68px');
  });

  // story #4349 AC5(유나 실측) — 모바일 서랍 문서 트리 행 메뉴가 목록 아래 끝에서 세로로 잘렸다: 아래가 모자라면 위로 뒤집는다.
  it('아래가 모자라고 위가 넓으면 위로 뒤집는다(트리거 위 8px · data-side=top) · 넉넉하면 아래(data-side=bottom)', () => {
    act(() => { root.render(<Harness />); });
    act(() => { document.getElementById('trigger')!.click(); });
    expect(pop().dataset.side).toBe('bottom');
    anchorRect = { left: 100, right: 180, top: 700, bottom: 720 }; // 뷰포트 768 · 팝오버 80 → 아래 32 · 위 684
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(pop().style.top).toBe('612px');
    expect(pop().dataset.side).toBe('top');
  });

  it('align="end" — 팝오버 오른쪽 끝을 트리거 오른쪽 끝에(예전 right-0)', () => {
    act(() => { root.render(<Harness align="end" />); });
    act(() => { document.getElementById('trigger')!.click(); });
    expect(pop().style.left).toBe('-44px'); // 180 − 224
  });
});

describe('placeVertical — 세로 자리(뷰포트 768 · 여백 8)', () => {
  it('아래에 다 들어가면 아래', () => {
    expect(placeVertical({ top: 40, bottom: 60 }, 80, 768, 4)).toEqual({ top: 64, side: 'bottom' });
  });
  it('아래가 모자라고 위가 넓으면 위(트리거 위 틈)', () => {
    expect(placeVertical({ top: 700, bottom: 720 }, 82, 768, 4)).toEqual({ top: 614, side: 'top' });
  });
  it('딱 맞으면 아래(경계: 아래 남는 칸 = 높이)', () => {
    expect(placeVertical({ top: 600, bottom: 676 }, 80, 768, 4)).toEqual({ top: 680, side: 'bottom' }); // 768 − 8 − 680 = 80
  });
  it('어느 쪽도 다 못 담으면 넓은 쪽에 두고 [8, 768 − 8] 안으로 민다', () => {
    expect(placeVertical({ top: 300, bottom: 320 }, 700, 768, 4)).toEqual({ top: 60, side: 'bottom' }); // 아래 436 ≥ 위 288 → 아래 · 324 → 760 − 700
    expect(placeVertical({ top: 500, bottom: 520 }, 700, 768, 4)).toEqual({ top: 8, side: 'top' }); // 위 488 > 아래 236 → 위 · −204 → 8
  });
});
