// @vitest-environment jsdom
//
// story 1948d19d — 캔버스 뷰포트 재설계 회귀가드. v1(overflow 스크롤)~v2.1(상시 드래그
// 오버레이)의 스크롤바/space 잔재가 전부 소멸했는지, 그리고 새 계약(전방향 pan·커서중심
// 줌·fit/100%·클릭=선택 드래그=pan 공존)이 실제로 동작하는지 검증한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { ArtifactStage, isResponsiveHtml } from './artifact-stage';
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

  describe('모바일 터치(story 74d6047e) — 2-finger 핀치 줌·더블탭 fit/100% 토글, 데스크톱 회귀 0', () => {
    let rectSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        x: 0, y: 0, left: 0, top: 0, right: 640, bottom: 480, width: 640, height: 480, toJSON() { return {}; },
      } as DOMRect);
    });
    afterEach(() => { rectSpy.mockRestore(); });

    function touchDown(el: EventTarget, pointerId: number, clientX: number, clientY: number) {
      press(el, 'pointerdown', { pointerId, pointerType: 'touch', clientX, clientY, button: 0 });
    }
    function touchMove(el: EventTarget, pointerId: number, clientX: number, clientY: number) {
      press(el, 'pointermove', { pointerId, pointerType: 'touch', clientX, clientY });
    }
    function touchUp(el: EventTarget, pointerId: number, clientX: number, clientY: number) {
      press(el, 'pointerup', { pointerId, pointerType: 'touch', clientX, clientY });
    }

    it('two fingers moving apart (distance ratio) zoom in, anchored at the pinch midpoint', async () => {
      await mount();
      const viewport = container.querySelector('[data-artifact-canvas-viewport]') as HTMLDivElement;
      const content = container.querySelector('[data-artifact-canvas-content]') as HTMLDivElement;
      const before = readTransform(content);

      await act(async () => {
        touchDown(viewport, 1, 100, 100);
        touchDown(viewport, 2, 200, 100); // baseline distance = 100
      });
      await act(async () => {
        touchMove(viewport, 1, 50, 100);
        touchMove(viewport, 2, 250, 100); // distance = 200 → 2x baseline
      });

      const after = readTransform(content);
      expect(after.scale).toBeCloseTo(before.scale * 2, 3);
    });

    it('pinch midpoint moving (without changing distance) pans simultaneously (Figma 표준 — 핀치+pan 동시)', async () => {
      await mount();
      const viewport = container.querySelector('[data-artifact-canvas-viewport]') as HTMLDivElement;
      const content = container.querySelector('[data-artifact-canvas-content]') as HTMLDivElement;

      await act(async () => {
        touchDown(viewport, 1, 100, 100);
        touchDown(viewport, 2, 200, 100); // baseline midpoint = (150,100)
      });
      const afterBaseline = readTransform(content);

      await act(async () => {
        // same distance(100), midpoint shifted +50 in x
        touchMove(viewport, 1, 150, 100);
        touchMove(viewport, 2, 250, 100); // new midpoint = (200,100)
      });
      const after = readTransform(content);

      expect(after.scale).toBeCloseTo(afterBaseline.scale, 5); // distance unchanged → no zoom
      expect(after.tx).toBeCloseTo(afterBaseline.tx + 50, 3); // midpoint moved +50 → pan +50
    });

    it('crux — capturing a 2nd finger mid-drag re-baselines instead of jumping (1→2 전이)', async () => {
      await mount();
      const viewport = container.querySelector('[data-artifact-canvas-viewport]') as HTMLDivElement;
      const content = container.querySelector('[data-artifact-canvas-content]') as HTMLDivElement;
      const before = readTransform(content);

      await act(async () => {
        touchDown(viewport, 1, 100, 100);
        touchMove(viewport, 1, 130, 100); // 1-finger pan by +30 (past 4px threshold)
      });
      const afterOneFingerPan = readTransform(content);
      expect(afterOneFingerPan.tx).toBeCloseTo(before.tx + 30, 3);

      // 2nd finger touches down at the SAME position as finger 1 currently is + a fixed offset —
      // baseline should capture from THIS moment, not jump based on finger 1's original down position.
      await act(async () => { touchDown(viewport, 2, 230, 100); });
      const afterSecondDown = readTransform(content);
      expect(afterSecondDown).toEqual(afterOneFingerPan); // pointerdown alone never mutates transform

      await act(async () => {
        touchMove(viewport, 1, 130, 100); // no movement from baseline
        touchMove(viewport, 2, 230, 100); // no movement from baseline
      });
      const afterNoMovePinch = readTransform(content);
      expect(afterNoMovePinch).toEqual(afterSecondDown); // zero delta from a fresh baseline = zero change (no jump)
    });

    it('crux — lifting one finger mid-pinch re-baselines pan for the remaining finger (2→1 전이, no jump)', async () => {
      await mount();
      const viewport = container.querySelector('[data-artifact-canvas-viewport]') as HTMLDivElement;
      const content = container.querySelector('[data-artifact-canvas-content]') as HTMLDivElement;

      await act(async () => {
        touchDown(viewport, 1, 100, 100);
        touchDown(viewport, 2, 300, 100); // baseline distance = 200
      });
      await act(async () => {
        touchMove(viewport, 1, 150, 100);
        touchMove(viewport, 2, 350, 100); // distance still 200 (both shifted +50) → pan only, no zoom
      });
      const afterPinchPan = readTransform(content);

      await act(async () => { touchUp(viewport, 1, 150, 100); }); // lift finger 1, finger 2 (at 350,100) remains
      await act(async () => { touchMove(viewport, 2, 350, 100); }); // no movement yet from the fresh baseline
      expect(readTransform(content)).toEqual(afterPinchPan); // no jump immediately after the finger-count transition

      await act(async () => { touchMove(viewport, 2, 380, 100); }); // now drag the remaining finger +30
      const afterResumedPan = readTransform(content);
      expect(afterResumedPan.tx).toBeCloseTo(afterPinchPan.tx + 30, 3);
      expect(afterResumedPan.scale).toBeCloseTo(afterPinchPan.scale, 5); // single remaining finger never zooms
    });

    it('clamps pinch zoom to the same 10%~400% range as desktop', async () => {
      await mount();
      const viewport = container.querySelector('[data-artifact-canvas-viewport]') as HTMLDivElement;
      const content = container.querySelector('[data-artifact-canvas-content]') as HTMLDivElement;

      await act(async () => {
        touchDown(viewport, 1, 300, 100);
        touchDown(viewport, 2, 320, 100); // baseline distance = 20 (tiny)
      });
      await act(async () => {
        touchMove(viewport, 1, 0, 100);
        touchMove(viewport, 2, 640, 100); // distance = 640 → 32x baseline, way past 400%
      });
      expect(readTransform(content).scale).toBeLessThanOrEqual(4);
    });

    it('a single tap (no follow-up within the window) does not toggle zoom', async () => {
      const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(1000);
      await mount();
      const viewport = container.querySelector('[data-artifact-canvas-viewport]') as HTMLDivElement;
      const content = container.querySelector('[data-artifact-canvas-content]') as HTMLDivElement;
      const before = readTransform(content);

      await act(async () => {
        touchDown(viewport, 1, 100, 100);
        touchUp(viewport, 1, 100, 100);
      });
      expect(readTransform(content)).toEqual(before);
      nowSpy.mockRestore();
    });

    it('double-tap within the time/distance window toggles zoom, centered on the tap point', async () => {
      const nowSpy = vi.spyOn(performance, 'now');
      await mount();
      const viewport = container.querySelector('[data-artifact-canvas-viewport]') as HTMLDivElement;
      const content = container.querySelector('[data-artifact-canvas-content]') as HTMLDivElement;
      const before = readTransform(content);

      nowSpy.mockReturnValue(1000);
      await act(async () => { touchDown(viewport, 1, 100, 100); touchUp(viewport, 1, 100, 100); }); // 1st tap
      nowSpy.mockReturnValue(1150); // within DOUBLE_TAP_MS(300) window
      await act(async () => { touchDown(viewport, 1, 105, 102); touchUp(viewport, 1, 105, 102); }); // 2nd tap, close position

      const after = readTransform(content);
      expect(after.scale).not.toBeCloseTo(before.scale, 3); // toggled to the other target scale
      nowSpy.mockRestore();
    });

    it('two taps outside the time window are treated as two independent single taps (no toggle)', async () => {
      const nowSpy = vi.spyOn(performance, 'now');
      await mount();
      const viewport = container.querySelector('[data-artifact-canvas-viewport]') as HTMLDivElement;
      const content = container.querySelector('[data-artifact-canvas-content]') as HTMLDivElement;
      const before = readTransform(content);

      nowSpy.mockReturnValue(1000);
      await act(async () => { touchDown(viewport, 1, 100, 100); touchUp(viewport, 1, 100, 100); });
      nowSpy.mockReturnValue(2000); // 1000ms later, past the 300ms window
      await act(async () => { touchDown(viewport, 1, 100, 100); touchUp(viewport, 1, 100, 100); });

      expect(readTransform(content)).toEqual(before);
      nowSpy.mockRestore();
    });

    it('mouse pointer events are entirely unaffected by the touch branch (pointerType gate — 데스크톱 회귀 0)', async () => {
      await mount();
      const viewport = container.querySelector('[data-artifact-canvas-viewport]') as HTMLDivElement;
      const content = container.querySelector('[data-artifact-canvas-content]') as HTMLDivElement;
      const before = readTransform(content);

      // a 2nd "pointer" with pointerType='mouse' must never be treated as a pinch partner.
      await act(async () => { press(viewport, 'pointerdown', { pointerId: 1, pointerType: 'mouse', clientX: 100, clientY: 100, button: 0 }); });
      await act(async () => { press(viewport, 'pointermove', { pointerId: 1, pointerType: 'mouse', clientX: 160, clientY: 130 }); });
      const after = readTransform(content);
      expect(after.tx).toBe(before.tx + 60);
      expect(after.ty).toBe(before.ty + 30);
      expect(after.scale).toBe(before.scale); // pan only, never zoom — single mouse pointer isn't a pinch
    });

    it('keeps touch-action:none (touch-none) on the viewport — 네이티브 핀치줌/스크롤 위임 없음, 우리 transform이 유일 소비자', async () => {
      await mount();
      const viewport = container.querySelector('[data-artifact-canvas-viewport]') as HTMLDivElement;
      expect(viewport.className).toContain('touch-none');
    });
  });

  describe('발견성 힌트(story 70a06b22) — pointer:coarse 판정에 따라 힌트 카피가 갈린다', () => {
    let matchMediaSpy: ReturnType<typeof vi.fn>;

    function stubMatchMedia(matches: boolean) {
      matchMediaSpy = vi.fn().mockReturnValue({ matches } as MediaQueryList);
      vi.stubGlobal('matchMedia', matchMediaSpy);
    }

    afterEach(() => { vi.unstubAllGlobals(); });

    it('shows the mouse hint when the device is not pointer:coarse (기존 회귀 0)', async () => {
      stubMatchMedia(false);
      await mount();
      expect(container.textContent).toContain('드래그로 이동, 휠로 확대·축소합니다');
      expect(container.textContent).not.toContain('한 손가락으로 이동');
      expect(matchMediaSpy).toHaveBeenCalledWith('(pointer: coarse)');
    });

    it('shows the touch hint when the device matches pointer:coarse (#2143에서 누락됐던 갭 봉합)', async () => {
      stubMatchMedia(true);
      await mount();
      expect(container.textContent).toContain('한 손가락으로 이동하고, 두 손가락으로 확대·축소합니다. 더블탭하면 화면에 맞춥니다.');
      expect(container.textContent).not.toContain('드래그로 이동, 휠로 확대·축소합니다');
    });
  });

  describe('반응형 미리보기(story 3d0d60a3) — previewWidth override는 iframe 자기 폭을 직접 교체한다(래퍼가 아니라, 구 토글 실패 원인 회피)', () => {
    it('overrides both the content layer and the iframe itself to previewWidth, keeping the authored height', async () => {
      await mount({ previewWidth: 375, canvasBounds: { w: 1280, h: 800 } });
      const content = container.querySelector('[data-artifact-canvas-content]') as HTMLDivElement;
      const iframe = container.querySelector('iframe') as HTMLIFrameElement;
      expect(content.style.width).toBe('375px');
      expect(content.style.height).toBe('800px'); // 저작 높이 유지(cross-origin이라 리플로우 높이 측정 불가·정직 단순화)
      expect(iframe.style.width).toBe('375px');
      expect(iframe.style.height).toBe('800px');
    });

    it('falls back to the authored canvas_bounds width when previewWidth is absent (데스크톱=원본, override 부재)', async () => {
      await mount({ canvasBounds: { w: 1280, h: 800 } });
      const content = container.querySelector('[data-artifact-canvas-content]') as HTMLDivElement;
      expect(content.style.width).toBe('1280px');
    });
  });

  describe('tree 포맷 — nodes=[] 조용한 폴백 방지(story 1da4cccf, 산출물 8de4e981 진단에서 발견)', () => {
    it('empty parsed tree("[]") shows an explicit "no content" placeholder, not a silent blank box', async () => {
      await mount({ format: 'tree', content: '[]' });
      expect(container.textContent).toContain('이 산출물에는 아직 콘텐츠가 없습니다');
      expect(container.textContent).not.toContain('트리 렌더는 준비 중');
    });

    it('unparseable content still shows the original parse-failure placeholder (별도 문구, 원인이 다름)', async () => {
      await mount({ format: 'tree', content: 'not json' });
      expect(container.textContent).toContain('트리 렌더는 준비 중');
      expect(container.textContent).not.toContain('이 산출물에는 아직 콘텐츠가 없습니다');
    });

    it('a non-empty tree renders its nodes as before (회귀 없음, 두 placeholder 모두 안 뜸)', async () => {
      await mount({ format: 'tree', content: JSON.stringify([{ id: 'n1', type: 'text', props: { text: 'hello' } }]) });
      expect(container.textContent).toContain('hello');
      expect(container.textContent).not.toContain('이 산출물에는 아직 콘텐츠가 없습니다');
      expect(container.textContent).not.toContain('트리 렌더는 준비 중');
    });
  });
});

describe('isResponsiveHtml(story 3d0d60a3) — @media 소스 파싱(유나 1순위 판정, 신규 BE 0)', () => {
  it('detects an actual @media rule with a body', () => {
    expect(isResponsiveHtml('<style>@media (max-width: 600px) { .a { color: red } }</style>')).toBe(true);
  });

  it('does not false-positive on the bare word "@media" appearing without a rule body', () => {
    expect(isResponsiveHtml('<p>이 문서는 @media 쿼리를 설명하는 글입니다</p>')).toBe(false);
  });

  it('returns false for fixed-width html with no media query at all (보수적 미노출, no-fiction)', () => {
    expect(isResponsiveHtml('<div style="width:1280px">fixed</div>')).toBe(false);
  });
});
