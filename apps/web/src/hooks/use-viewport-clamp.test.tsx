// @vitest-environment jsdom
// story #4342 — 한쪽 맞춤 고정 폭 드롭다운을 뷰포트 안(양쪽 8px)으로 밀어 넣는 훅. jsdom은 배치를 안 해서 패널 사각형을 목으로 두고,
// 훅이 건 translateX를 더한 «실제 경계»가 뷰포트 안인지 잰다(유나 390px 실측 37px 넘침을 그대로 재현).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useViewportClampRef, viewportShiftX, VIEWPORT_GUTTER_PX } from './use-viewport-clamp';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('viewportShiftX(story #4342)', () => {
  it('왼쪽 넘침 → 오른쪽으로 · 오른쪽 넘침 → 왼쪽으로 · 안이면 0', () => {
    expect(viewportShiftX({ left: -37, right: 219 }, 390)).toBe(VIEWPORT_GUTTER_PX + 37);
    expect(viewportShiftX({ left: 200, right: 456 }, 390)).toBe(390 - VIEWPORT_GUTTER_PX - 456);
    expect(viewportShiftX({ left: 20, right: 276 }, 390)).toBe(0);
    expect(viewportShiftX({ left: 1100, right: 1356 }, 1440)).toBe(0);
  });
  it('양쪽 다 넘치면 왼쪽(글 시작 · 표식)을 먼저 살린다', () => {
    expect(viewportShiftX({ left: -10, right: 400 }, 390)).toBe(VIEWPORT_GUTTER_PX + 10);
  });
});

let container: HTMLDivElement;
let root: Root;
let panelRect: { left: number; width: number };
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.hasAttribute('data-panel')) {
      const { left, width } = panelRect;
      return { left, right: left + width, width, top: 0, bottom: 100, height: 100, x: left, y: 0, toJSON() {} } as DOMRect;
    }
    return { left: 0, right: 0, width: 0, top: 0, bottom: 0, height: 0, x: 0, y: 0, toJSON() {} } as DOMRect;
  });
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.restoreAllMocks(); });

function Probe() {
  const [open, setOpen] = useState(false);
  const clampRef = useViewportClampRef<HTMLDivElement>();
  return (
    <div>
      <button type="button" onClick={() => setOpen((v) => !v)}>open</button>
      {open ? <div ref={clampRef} data-panel="">panel</div> : null}
    </div>
  );
}
const shiftOf = (el: HTMLElement) => Number(/translateX\((-?[\d.]+)px\)/.exec(el.style.transform)?.[1] ?? 0);

describe('useViewportClampRef(story #4342)', () => {
  it('390px에서 왼쪽으로 37px 넘친 패널 → 열릴 때 안으로 밀려 [8, 382] 안', async () => {
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(390);
    panelRect = { left: -37, width: 256 };
    await act(async () => { root.render(<Probe />); });
    await act(async () => { container.querySelector('button')!.click(); });
    const panel = container.querySelector('[data-panel]') as HTMLElement;
    const left = panelRect.left + shiftOf(panel);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(left + panelRect.width).toBeLessThanOrEqual(390);
    expect(left).toBe(VIEWPORT_GUTTER_PX);
  });

  it('넉넉한 화면(1440)에선 아무것도 안 한다(모양 그대로)', async () => {
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1440);
    panelRect = { left: 1100, width: 256 };
    await act(async () => { root.render(<Probe />); });
    await act(async () => { container.querySelector('button')!.click(); });
    expect((container.querySelector('[data-panel]') as HTMLElement).style.transform).toBe('');
  });

  it('창이 좁아지면 다시 잰다(resize)', async () => {
    const width = vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1440);
    panelRect = { left: 300, width: 256 };
    await act(async () => { root.render(<Probe />); });
    await act(async () => { container.querySelector('button')!.click(); });
    const panel = container.querySelector('[data-panel]') as HTMLElement;
    expect(panel.style.transform).toBe('');
    width.mockReturnValue(360);
    await act(async () => { window.dispatchEvent(new Event('resize')); });
    expect(panelRect.left + shiftOf(panel) + panelRect.width).toBeLessThanOrEqual(360 - VIEWPORT_GUTTER_PX);
  });
});
