// @vitest-environment jsdom
//
// 4910 ④ — 그림 칸 다시 맞춤: 이미지는 처음엔 선언 크기(없으면 기본 1280×800)로 «전체 보기»를 맞춘 뒤 불러지며 실제 크기가 알려진다.
// 실제 크기가 알려졌을 때 사용자가 아직 화면을 안 만졌으면 한 번 다시 맞추고, 만졌으면(끌기 · 휠 · 핀치 · 더블클릭 · 실제 크기) 건드리지 않는다. 크기마다 한 번, 내용이 바뀌면 처음부터.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { ArtifactStage } from './artifact-stage';
import koMessages from '../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const sizeGetters: PropertyDescriptor[] = [];
let viewW = 640;
let viewH = 480;

// 640×480 칸 고정(jsdom은 0). 기본 아트보드 1280×800 → fit 0.5. 실제 크기 320×200 → fit 2, 160×100 → fit 4(MAX).
beforeEach(() => {
  viewW = 640; viewH = 480;
  for (const prop of ['clientWidth', 'clientHeight'] as const) {
    sizeGetters.push(Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop) ?? { value: 0, configurable: true });
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get() { return prop === 'clientWidth' ? viewW : viewH; } });
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await act(async () => { root.unmount(); });
  container.remove();
  (['clientWidth', 'clientHeight'] as const).forEach((prop, i) => Object.defineProperty(HTMLElement.prototype, prop, sizeGetters[i]!));
  sizeGetters.length = 0;
});

const wrap = (node: React.ReactNode) => (
  <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>
);
const mountImage = (src = 'https://cdn.example.com/a.png', format: 'image' | 'html' = 'image') => act(async () => {
  root.render(wrap(<ArtifactStage format={format} content={format === 'html' ? '<div>hi</div>' : src} title="시안" />));
});
const viewport = () => container.querySelector('[data-artifact-canvas-viewport]') as HTMLDivElement;
const scaleNow = () => Number(/scale\(([-\d.]+)\)/.exec((container.querySelector('[data-artifact-canvas-content]') as HTMLElement).style.transform)![1]);
const loadImage = (w: number, h: number) => act(async () => {
  const img = container.querySelector('img')!;
  Object.defineProperty(img, 'naturalWidth', { configurable: true, value: w });
  Object.defineProperty(img, 'naturalHeight', { configurable: true, value: h });
  img.dispatchEvent(new Event('load'));
});
const pointer = (type: string, init: PointerEventInit) => act(async () => { viewport().dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 3, pointerType: 'mouse', button: 0, ...init })); });
const drag = async () => { await pointer('pointerdown', { clientX: 100, clientY: 100 }); await pointer('pointermove', { clientX: 160, clientY: 140 }); await pointer('pointerup', { clientX: 160, clientY: 140 }); };
const wheel = (init: WheelEventInit) => act(async () => { viewport().dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 200, clientY: 200, ...init })); });
const key = (k: string) => act(async () => { viewport().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); });
const dblclick = () => act(async () => { viewport().dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 })); });

describe('ArtifactStage — 이미지 실제 크기를 알았을 때 다시 맞춤 (4910 ④)', () => {
  it('손대기 전: 선언(기본) 크기로 맞춘 0.5 → 이미지가 불러져 실제 크기(320×200)가 알려지면 그 크기로 다시 맞춤(2)', async () => {
    await mountImage();
    expect(scaleNow()).toBeCloseTo(0.5, 3);
    await loadImage(320, 200);
    expect(scaleNow()).toBeCloseTo(2, 3);
  });

  it('끌기 · 휠(확대 · 이동) · 실제 크기 키 · 더블클릭 중 하나라도 먼저 했으면 다시 맞추지 않는다', async () => {
    const touches: Array<[string, () => Promise<void>, number]> = [
      ['끌기', drag, 0.5],
      ['⌘/Ctrl 휠 확대', () => wheel({ ctrlKey: true, deltaY: -100 }), -1],
      ['일반 휠 이동', () => wheel({ deltaX: 10, deltaY: 10 }), 0.5],
      ['키 1(실제 크기)', () => key('1'), 1],
      ['더블클릭(줌 토글)', dblclick, 1],
    ];
    for (const [name, act1, expected] of touches) {
      await act(async () => { root.unmount(); });
      root = createRoot(container);
      await mountImage(`https://cdn.example.com/${name}.png`);
      await act1();
      const before = scaleNow();
      if (expected >= 0) expect(before, `${name} 직후`).toBeCloseTo(expected, 2);
      await loadImage(320, 200);
      expect(scaleNow(), `${name} 뒤 불러져도 그대로`).toBeCloseTo(before, 5);
    }
  });

  it('«전체 보기»(키 0)는 만짐이 아니다 — 불러진 뒤에는 그래도 다시 맞춘다', async () => {
    await mountImage();
    await key('0');
    await loadImage(320, 200);
    expect(scaleNow()).toBeCloseTo(2, 3);
  });

  it('같은 크기의 load가 또 와도 한 번만: 다시 맞춘 뒤 사용자가 줌을 바꾸면 되돌리지 않는다', async () => {
    await mountImage();
    await loadImage(320, 200);
    expect(scaleNow()).toBeCloseTo(2, 3);
    await key('1'); // 사용자가 실제 크기로
    await loadImage(320, 200); // 같은 크기 load 한 번 더
    expect(scaleNow()).toBeCloseTo(1, 3);
  });

  it('다른 크기가 알려지면(손대기 전) 그 크기로 다시 맞추고, 손댄 뒤에는 안 맞춘다', async () => {
    await mountImage();
    await loadImage(320, 200);
    expect(scaleNow()).toBeCloseTo(2, 3);
    await loadImage(160, 100);
    expect(scaleNow()).toBeCloseTo(4, 3);
    await key('1');
    await loadImage(640, 400);
    expect(scaleNow()).toBeCloseTo(1, 3);
  });

  it('내용이 바뀌면 처음부터: 손댄 뒤라도 새 그림이 불러지면 다시 맞춘다', async () => {
    await mountImage('https://cdn.example.com/one.png');
    await key('1');
    await loadImage(320, 200);
    expect(scaleNow()).toBeCloseTo(1, 3);
    await mountImage('https://cdn.example.com/two.png');
    await loadImage(320, 200);
    expect(scaleNow()).toBeCloseTo(2, 3);
  });

  it('창 · 칸 크기가 바뀌어도(손대기 전이라도) 다시 맞추지 않는다 — 처음 맞춤은 «최초 1회», 다시 맞춤은 «이미지 크기가 새로 알려진 때»만', async () => {
    let notify: () => void = () => undefined;
    class FakeResizeObserver { constructor(cb: () => void) { notify = cb; } observe() {} disconnect() {} unobserve() {} }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    await mountImage();
    await loadImage(320, 200);
    expect(scaleNow()).toBeCloseTo(2, 3);
    viewW = 320; viewH = 240; // 칸이 반으로 줄어듦
    await act(async () => { notify(); });
    expect(scaleNow()).toBeCloseTo(2, 3); // 그대로 — 사용자가 «전체 보기»를 누를 때까지
  });

  it('이미지가 아닌 형식(html)은 건드리지 않는다 — img도 없고 배율은 처음 맞춘 그대로', async () => {
    await mountImage('', 'html');
    expect(container.querySelector('img')).toBeNull();
    expect(scaleNow()).toBeCloseTo(0.5, 3);
  });
});
