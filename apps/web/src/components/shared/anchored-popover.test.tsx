// @vitest-environment jsdom
//
// story #4349 — AnchoredPopover: 트리거에 붙는 팝오버를 부모 overflow 밖(body)에 fixed로 그린다.
// jsdom은 배치를 안 해서 트리거 · 팝오버 사각형을 값으로 둔다(뷰포트 1024).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AnchoredPopover } from './anchored-popover';

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
function Harness({ offsetX, initiallyOpen = false }: { offsetX?: number; initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const anchorRef = useRef<HTMLDivElement>(null);
  return (
    <div className="flex overflow-x-auto">
      <div id="anchor" ref={open ? anchorRef : undefined} className="relative">
        <button type="button" id="trigger" onClick={() => setOpen((v) => !v)}>열기</button>
        {open && <AnchoredPopover anchorRef={anchorRef} offsetX={offsetX} id="pop" role="tooltip" className="w-56">안내</AnchoredPopover>}
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

  it('처음부터 열린 채 붙어도(트리거 ref가 자식보다 늦게 붙는 순서) 제자리에 드러난다', () => {
    act(() => { root.render(<Harness initiallyOpen />); });
    expect(pop().style.visibility).toBe('');
    expect(pop().style.top).toBe('68px');
  });
});
