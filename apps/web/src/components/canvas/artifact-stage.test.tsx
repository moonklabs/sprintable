// @vitest-environment jsdom
//
// story 1948d19d — 캔버스 뷰포트 재설계 회귀가드. v1(overflow 스크롤)~v2.1(상시 드래그
// 오버레이)의 스크롤바/space 잔재가 전부 소멸했는지, 그리고 새 계약(전방향 pan·커서중심
// 줌·fit/100%·클릭=선택 드래그=pan 공존)이 실제로 동작하는지 검증한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { ArtifactStage } from './artifact-stage';
import koMessages from '../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

async function mount(props: Partial<React.ComponentProps<typeof ArtifactStage>> = {}) {
  await act(async () => {
    root.render(wrap(<ArtifactStage format="html" content="<div>hi</div>" title="t" {...props} />));
  });
}

function press(el: EventTarget, type: string, init: PointerEventInit | WheelEventInit = {}) {
  const Ctor = type.startsWith('wheel') ? WheelEvent : PointerEvent;
  el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, ...init }));
}

function readTransform(el: HTMLElement) {
  const m = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/.exec(el.style.transform);
  if (!m) throw new Error(`unparseable transform: ${el.style.transform}`);
  return { tx: Number(m[1]), ty: Number(m[2]), scale: Number(m[3]) };
}

describe('ArtifactStage — 캔버스 뷰포트(story 1948d19d)', () => {
  it('locks down the html sandbox and marks content pointer-events:none (crux — 상시 캡처 오버레이 폐기)', async () => {
    await mount();
    const iframe = container.querySelector('iframe') as HTMLIFrameElement;
    expect(iframe).not.toBeNull();
    expect(iframe.getAttribute('sandbox')).toBe('');
    expect(iframe.className).toContain('pointer-events-none');
  });

  it('never renders the v1~v2.1 scroll/overlay remnants (data-artifact-stage-scroll·data-pan-overlay)', async () => {
    await mount();
    expect(container.querySelector('[data-artifact-stage-scroll]')).toBeNull();
    expect(container.querySelector('[data-pan-overlay]')).toBeNull();
  });

  it('pointerdown+drag past the threshold pans the content (translate reflects the drag delta)', async () => {
    await mount();
    const viewport = container.querySelector('[data-artifact-canvas-viewport]') as HTMLDivElement;
    const content = container.querySelector('[data-artifact-canvas-content]') as HTMLDivElement;
    const before = readTransform(content);

    await act(async () => {
      press(viewport, 'pointerdown', { pointerId: 1, clientX: 100, clientY: 100, button: 0 });
    });
    await act(async () => {
      press(viewport, 'pointermove', { pointerId: 1, clientX: 160, clientY: 130 }); // 60,30 — 임계(4px) 초과
    });
    const after = readTransform(content);
    expect(after.tx).toBe(before.tx + 60);
    expect(after.ty).toBe(before.ty + 30);

    await act(async () => { press(viewport, 'pointerup', { pointerId: 1, clientX: 160, clientY: 130 }); });
  });

  it('a drag past the threshold makes the overlay pointer-events:none (핀 위 드래그=pan, 선택 미커밋 — CSS 메커니즘)', async () => {
    await mount({ overlay: <button type="button" data-testid="pin">pin</button> });
    const viewport = container.querySelector('[data-artifact-canvas-viewport]') as HTMLDivElement;
    const overlay = container.querySelector('[data-artifact-canvas-overlay]') as HTMLDivElement;
    expect(overlay.style.pointerEvents).not.toBe('none');

    await act(async () => { press(viewport, 'pointerdown', { pointerId: 1, clientX: 0, clientY: 0, button: 0 }); });
    await act(async () => { press(viewport, 'pointermove', { pointerId: 1, clientX: 50, clientY: 0 }); });
    expect(overlay.style.pointerEvents).toBe('none');

    await act(async () => { press(viewport, 'pointerup', { pointerId: 1, clientX: 50, clientY: 0 }); });
    expect(overlay.style.pointerEvents).not.toBe('none');
  });

  it('a click without movement (< threshold) does not pan (임계 미달 = 클릭, transform 무변)', async () => {
    await mount();
    const viewport = container.querySelector('[data-artifact-canvas-viewport]') as HTMLDivElement;
    const content = container.querySelector('[data-artifact-canvas-content]') as HTMLDivElement;
    const before = readTransform(content);

    await act(async () => { press(viewport, 'pointerdown', { pointerId: 1, clientX: 100, clientY: 100, button: 0 }); });
    await act(async () => { press(viewport, 'pointermove', { pointerId: 1, clientX: 101, clientY: 101 }); }); // 1.4px, 임계(4px) 미달
    await act(async () => { press(viewport, 'pointerup', { pointerId: 1, clientX: 101, clientY: 101 }); });

    expect(readTransform(content)).toEqual(before);
  });

  it('plain wheel pans (no ctrl/meta) — deltaX/Y move the content', async () => {
    await mount();
    const viewport = container.querySelector('[data-artifact-canvas-viewport]') as HTMLDivElement;
    const content = container.querySelector('[data-artifact-canvas-content]') as HTMLDivElement;
    const before = readTransform(content);
    await act(async () => { press(viewport, 'wheel', { deltaX: 20, deltaY: 10, ctrlKey: false }); });
    const after = readTransform(content);
    expect(after.tx).toBe(before.tx - 20);
    expect(after.ty).toBe(before.ty - 10);
    expect(after.scale).toBe(before.scale);
  });

  it('ctrl/meta+wheel zooms instead of panning (트랙패드 핀치와 동일 신호)', async () => {
    await mount();
    const viewport = container.querySelector('[data-artifact-canvas-viewport]') as HTMLDivElement;
    const content = container.querySelector('[data-artifact-canvas-content]') as HTMLDivElement;
    const before = readTransform(content);
    await act(async () => { press(viewport, 'wheel', { deltaY: -100, ctrlKey: true, clientX: 50, clientY: 50 }); });
    const after = readTransform(content);
    expect(after.scale).toBeGreaterThan(before.scale); // deltaY<0 = zoom in
  });

  it('clamps zoom to the 10%~400% range (repeated zoom does not exceed bounds)', async () => {
    await mount();
    const viewport = container.querySelector('[data-artifact-canvas-viewport]') as HTMLDivElement;
    const content = container.querySelector('[data-artifact-canvas-content]') as HTMLDivElement;
    for (let i = 0; i < 40; i++) {
      await act(async () => { press(viewport, 'wheel', { deltaY: -1000, ctrlKey: true, clientX: 0, clientY: 0 }); });
    }
    expect(readTransform(content).scale).toBeLessThanOrEqual(4);
    for (let i = 0; i < 40; i++) {
      await act(async () => { press(viewport, 'wheel', { deltaY: 1000, ctrlKey: true, clientX: 0, clientY: 0 }); });
    }
    expect(readTransform(content).scale).toBeGreaterThanOrEqual(0.1);
  });

  it('the actual-size(100%) button sets scale to 1', async () => {
    await mount();
    const button = [...container.querySelectorAll('button')].find((b) => b.textContent === '실제 크기');
    expect(button).toBeDefined();
    const content = container.querySelector('[data-artifact-canvas-content]') as HTMLDivElement;
    await act(async () => { button!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(readTransform(content).scale).toBe(1);
  });

  it('attaches wheel via a native non-passive listener (crux — React onWheel silently no-ops preventDefault, leaking to page scroll/native ctrl-wheel zoom)', async () => {
    const addSpy = vi.spyOn(HTMLElement.prototype, 'addEventListener');
    await mount();
    const wheelCall = addSpy.mock.calls.find((call) => call[0] === 'wheel');
    expect(wheelCall).toBeDefined();
    expect(wheelCall?.[2]).toMatchObject({ passive: false });
    addSpy.mockRestore();
  });

  it('plain wheel over a [data-canvas-scrollable] region with real overflow yields to native inner scroll instead of panning (까심 QA 발견, PR#2138)', async () => {
    await mount({
      overlay: (
        <div data-canvas-scrollable data-testid="scroll-region">
          <button type="button" data-testid="node">node</button>
        </div>
      ),
    });
    const scrollRegion = container.querySelector('[data-canvas-scrollable]') as HTMLElement;
    Object.defineProperty(scrollRegion, 'scrollHeight', { value: 2000, configurable: true });
    Object.defineProperty(scrollRegion, 'clientHeight', { value: 400, configurable: true });
    const node = container.querySelector('[data-testid="node"]') as HTMLElement;
    const content = container.querySelector('[data-artifact-canvas-content]') as HTMLDivElement;
    const before = readTransform(content);

    await act(async () => { press(node, 'wheel', { deltaX: 0, deltaY: 50, ctrlKey: false }); });
    expect(readTransform(content)).toEqual(before);
  });

  it('ctrl/meta+wheel over the same overflowing region still zooms (줌 의도는 무조건 소비 — 네이티브 페이지 줌 누출 방지가 어디서도 안 깨짐)', async () => {
    await mount({
      overlay: (
        <div data-canvas-scrollable data-testid="scroll-region">
          <button type="button" data-testid="node">node</button>
        </div>
      ),
    });
    const scrollRegion = container.querySelector('[data-canvas-scrollable]') as HTMLElement;
    Object.defineProperty(scrollRegion, 'scrollHeight', { value: 2000, configurable: true });
    Object.defineProperty(scrollRegion, 'clientHeight', { value: 400, configurable: true });
    const node = container.querySelector('[data-testid="node"]') as HTMLElement;
    const content = container.querySelector('[data-artifact-canvas-content]') as HTMLDivElement;
    const before = readTransform(content);

    await act(async () => { press(node, 'wheel', { deltaY: -100, ctrlKey: true, clientX: 10, clientY: 10 }); });
    expect(readTransform(content).scale).toBeGreaterThan(before.scale);
  });

  it('renders the fit and actual-size chrome buttons plus a live zoom percentage — no v1~v2.1 scrollbar/space chrome', async () => {
    await mount();
    expect(container.textContent).toContain('전체 보기');
    expect(container.textContent).toContain('실제 크기');
    expect(container.textContent).toMatch(/\d+%/);
    expect(container.textContent).not.toContain('끌어서 이동');
  });

  it('contentRef attaches to the content layer itself, excluding the chrome bar (story d72db00a — PNG export capture target)', async () => {
    const contentRef = { current: null } as React.RefObject<HTMLDivElement | null>;
    await mount({ contentRef });
    const content = container.querySelector('[data-artifact-canvas-content]') as HTMLDivElement;
    expect(contentRef.current).toBe(content);
    // 크롬 바(힌트·줌%·fit/100% 버튼)는 이 div의 형제라, ref 대상 안에는 없다.
    expect(contentRef.current?.textContent).not.toContain('전체 보기');
    expect(contentRef.current?.textContent).not.toContain('실제 크기');
  });

  describe('fit/초기 진입 — 뷰포트 실측 필요(jsdom clientWidth/Height는 기본 0, 스텁 필요)', () => {
    let widthSpy: ReturnType<typeof vi.spyOn>;
    let heightSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      widthSpy = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(640);
      heightSpy = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(480);
    });
    afterEach(() => {
      widthSpy.mockRestore();
      heightSpy.mockRestore();
    });

    it('auto-fits on first mount (전체 콘텐츠가 즉시 보이는 것이 재설계의 근본 목적)', async () => {
      await mount();
      const content = container.querySelector('[data-artifact-canvas-content]') as HTMLDivElement;
      // bounds 1280x800 vs viewport 640x480 → fit scale = min(640/1280, 480/800) = 0.5
      expect(readTransform(content).scale).toBeCloseTo(0.5, 5);
    });

    it('the fit button recomputes scale to contain the full bounds after zooming away', async () => {
      await mount();
      const viewport = container.querySelector('[data-artifact-canvas-viewport]') as HTMLDivElement;
      const content = container.querySelector('[data-artifact-canvas-content]') as HTMLDivElement;
      await act(async () => { press(viewport, 'wheel', { deltaY: -1000, ctrlKey: true, clientX: 0, clientY: 0 }); });
      expect(readTransform(content).scale).not.toBeCloseTo(0.5, 5);

      const fitButton = [...container.querySelectorAll('button')].find((b) => b.textContent === '전체 보기');
      await act(async () => { fitButton!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      expect(readTransform(content).scale).toBeCloseTo(0.5, 5);
    });
  });
});
