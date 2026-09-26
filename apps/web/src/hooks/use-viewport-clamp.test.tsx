// @vitest-environment jsdom
// story #4342 — 한쪽 맞춤 고정 폭 드롭다운을 뷰포트 안(양쪽 8px)으로 밀어 넣는 훅. jsdom은 배치를 안 해서 패널 사각형을 목으로 두고,
// 훅이 건 translateX를 더한 «실제 경계»가 뷰포트 안인지 잰다(유나 390px 실측 37px 넘침을 그대로 재현).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { clampIntoViewX, clipBoxX, shiftIntoBoxX, useViewportClampRef, viewportShiftX, VIEWPORT_GUTTER_PX } from './use-viewport-clamp';

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

// story #4342 · 유나 4714 CHANGES — 보이는 상자 = 뷰포트 ∩ 잘라내는 조상(overflow ≠ visible)의 안쪽 상자. 여백 8px은 그 안에서.
// jsdom은 배치를 안 해서 조상 사각형 · clientLeft · clientWidth를 data-* 값으로 둔다(overflow · position은 인라인 style → getComputedStyle).
describe('clipBoxX · shiftIntoBoxX · clampIntoViewX(유나 4714 CHANGES)', () => {
  let rectSpy: ReturnType<typeof vi.spyOn>;
  const hosts: HTMLElement[] = [];
  afterEach(() => { hosts.splice(0).forEach((h) => h.remove()); }); // 단언이 먼저 던져도 고정물이 다음 판에 새지 않게
  beforeEach(() => {
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(390);
    rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const l = Number(this.dataset.l ?? 0);
      const maxW = parseFloat(this.style.maxWidth);
      const w = Math.min(Number(this.dataset.w ?? 0), Number.isFinite(maxW) ? maxW : Infinity);
      return { left: l, right: l + w, width: w, top: 0, bottom: 10, height: 10, x: l, y: 0, toJSON() {} } as DOMRect;
    });
    vi.spyOn(HTMLElement.prototype, 'clientLeft', 'get').mockImplementation(function (this: HTMLElement) { return Number(this.dataset.cl ?? 0); });
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) { return Number(this.dataset.cw ?? 0); });
  });

  // 실 셸 부모 사슬(문서 화면): 본문 `overflow-hidden px-4`(0~390) → 에디터 카드 `overflow-hidden` · 16px 안쪽 · 테두리 1px → 담는 블록(relative) → 패널(absolute)
  function chain(panelLeft: number, panelW: number, opts: { clipBetween?: boolean; panelPos?: string } = {}) {
    const host = document.createElement('div');
    host.innerHTML = `
      <div style="overflow:hidden" data-l="0" data-w="390" data-cl="0" data-cw="390">
        <div style="overflow:hidden" data-l="16" data-w="358" data-cl="1" data-cw="356">
          <div style="position:relative" data-l="200" data-w="40">
            <div ${opts.clipBetween ? 'style="overflow:hidden" data-l="220" data-w="10" data-cl="0" data-cw="10"' : ''}>
              <div id="panel" style="position:${opts.panelPos ?? 'absolute'}" data-l="${panelLeft}" data-w="${panelW}">패널</div>
            </div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(host);
    hosts.push(host);
    return { host, panel: host.querySelector<HTMLElement>('#panel')! };
  }
  const finalLeft = (p: HTMLElement) => Number(p.dataset.l) + Number(/translateX\((-?[\d.]+)px\)/.exec(p.style.transform)?.[1] ?? 0);

  it('shiftIntoBoxX — 상자 [17, 373] 안 여백 8 → [25, 365]', () => {
    expect(shiftIntoBoxX({ left: -37, right: 219 }, { left: 17, right: 373 })).toBe(62);
    expect(shiftIntoBoxX({ left: 120, right: 389 }, { left: 17, right: 373 })).toBe(365 - 389);
    expect(shiftIntoBoxX({ left: 30, right: 300 }, { left: 17, right: 373 })).toBe(0);
  });

  it('clipBoxX — 에디터 카드(16px 안쪽 · 테두리 1px)와 본문을 뷰포트와 겹친 [17, 373]', () => {
    const { panel } = chain(-37, 256);
    expect(clipBoxX(panel)).toEqual({ left: 17, right: 373 });
  });

  it('390 목차(왼쪽 −37): 뷰포트 기준 8이 아니라 카드 안쪽 + 8 = 25 — 한 변도 안 잘림', () => {
    const { panel } = chain(-37, 256);
    clampIntoViewX(panel);
    expect(finalLeft(panel)).toBe(25);
    expect(finalLeft(panel) + 256).toBeLessThanOrEqual(373 - VIEWPORT_GUTTER_PX);
  });

  it('360 md 복사 실패(오른쪽 389 · 288px): 카드 안쪽 오른쪽 − 8 안으로', () => {
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(360);
    const host = document.createElement('div');
    host.innerHTML = `<div style="overflow:hidden" data-l="16" data-w="328" data-cl="1" data-cw="326"><div style="position:relative"><div id="p" style="position:absolute" data-l="101" data-w="288">x</div></div></div>`;
    document.body.appendChild(host);
    hosts.push(host);
    const p = host.querySelector<HTMLElement>('#p')!;
    clampIntoViewX(p);
    const left = finalLeft(p);
    expect(left).toBeGreaterThanOrEqual(17 + VIEWPORT_GUTTER_PX);
    expect(left + 288).toBeLessThanOrEqual(17 + 326 - VIEWPORT_GUTTER_PX);
  });

  it('담는 블록 아래의 overflow(패널과 담는 블록 사이)는 못 자른다 → 셈하지 않는다', () => {
    const { panel } = chain(-37, 256, { clipBetween: true });
    expect(clipBoxX(panel)).toEqual({ left: 17, right: 373 });
  });

  it('fixed 패널(body 포털 등)은 조상 overflow에 안 잘린다 → 뷰포트만', () => {
    const { panel } = chain(-37, 256, { panelPos: 'fixed' });
    expect(clipBoxX(panel)).toEqual({ left: 0, right: 390 });
  });

  it('상자(− 여백 둘)보다 넓은 패널 → 인라인 max-width로 줄인 뒤 안으로', () => {
    const { panel } = chain(-37, 380);
    clampIntoViewX(panel);
    expect(panel.style.maxWidth).toBe(`${373 - 17 - 2 * VIEWPORT_GUTTER_PX}px`);
    expect(finalLeft(panel)).toBe(25);
    expect(rectSpy).toHaveBeenCalled();
  });
});
