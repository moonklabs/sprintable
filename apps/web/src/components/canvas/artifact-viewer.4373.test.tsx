// @vitest-environment jsdom
/**
 * story #4373 — 산출물 댓글 쓰기 칸이 캔버스 확대/축소 변환 **안**(overlay)에 그려져 무대 10%면 22×10px로 작아지고(글 안 보임)
 * 단추 누름이 뷰포트의 pan · 픽 처리로 새던 결함.
 * 1차(무대 크기 화면 층)는 좁은 곁 패널(무대 61px)에서 칸이 잘려 단추가 안 눌렸다(유나 실측) → 이제 쓰기 칸은 **body 포털 + fixed**
 * (`AnchoredPopover`): 핀 사각형 아래(모자라면 위)에 붙고 창 안으로 밀리며 · pan/zoom으로 핀이 움직이면 따라간다.
 * 칸 위 휠은 핀의 뷰포트로 넘긴다(까디르 실측 — 포털이라 무대의 네이티브 wheel 리스너를 안 거쳐 ctrl+휠이 페이지 줌으로 샜다).
 * jsdom엔 배치가 없어 getBoundingClientRect를 요소별로 흉내 낸다(핀 · 쓰기 칸 · 나머지 = 1280×800 무대).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ArtifactViewer } from './artifact-viewer';
import { MOCK_ARTIFACT, MOCK_VERSIONS, MOCK_MEMBERS } from '@/services/canvas';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const canvas = koMessages.canvas as unknown as Record<string, string>;
let BOX = { w: 224, h: 120 };
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let rectSpy: ReturnType<typeof vi.spyOn>;
let pinRect = { left: 600, top: 390, width: 20, height: 20 };
const win = { w: window.innerWidth, h: window.innerHeight };

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { x: left, y: top, left, top, right: left + width, bottom: top + height, width, height, toJSON() { return {}; } } as DOMRect;
}
function setWindow(w: number, h: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: w });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: h });
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: w });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  pinRect = { left: 600, top: 390, width: 20, height: 20 };
  BOX = { w: 224, h: 120 };
  setWindow(1280, 800);
  rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.hasAttribute('data-anchored-popover')) {
      const shift = Number(/translateX\((-?[\d.]+)px\)/.exec(this.style.transform)?.[1] ?? 0);
      return rect(parseFloat(this.style.left || '0') + shift, parseFloat(this.style.top || '0'), BOX.w, BOX.h);
    }
    if (this.className.includes('border-dashed')) return rect(pinRect.left, pinRect.top, pinRect.width, pinRect.height);
    // artifact-viewer.test.tsx와 같은 기법 — 무대 bounds(1280x800) 1:1(scale=1 · jsdom은 clientWidth 0이라 자동 맞춤 없음).
    return rect(0, 0, 1280, 800);
  });
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  rectSpy.mockRestore();
  setWindow(win.w, win.h);
});

async function mountWithDraftPin(clientX = 640, clientY = 400) {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <ArtifactViewer artifact={MOCK_ARTIFACT} versions={MOCK_VERSIONS} memberMap={MOCK_MEMBERS} threads={[]} onCreateThread={async () => true} />
      </NextIntlClientProvider>,
    );
  });
  const toggle = container.querySelector('button[aria-pressed]') as HTMLButtonElement;
  await act(async () => { toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await act(async () => {
    viewport().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, clientX, clientY, button: 0 }));
    viewport().dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientX, clientY }));
  });
}
const nextFrames = () => act(async () => { for (let i = 0; i < 3; i += 1) await new Promise((r) => requestAnimationFrame(() => r(null))); });
const compose = () => document.querySelector<HTMLTextAreaElement>(`textarea[placeholder="${canvas.newThreadComposePlaceholder}"]`);
const composeBox = () => compose()!.closest<HTMLElement>('[data-anchored-popover]')!;
const viewport = () => container.querySelector('[data-artifact-canvas-viewport]') as HTMLDivElement;
const content = () => container.querySelector('[data-artifact-canvas-content]') as HTMLElement;
const boxAt = () => {
  const r = composeBox().getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
};

describe('산출물 댓글 쓰기 칸은 무대 밖 — body 포털 + fixed로 핀 사각형에 붙는다(story #4373)', () => {
  it('쓰기 칸은 무대(뷰포트 · 변환 층)의 자손이 아니다 — body 포털 · fixed · 어떤 조상도 scale 변환을 걸지 않는다', async () => {
    await mountWithDraftPin();
    expect(compose()).not.toBeNull();
    expect(container.contains(compose())).toBe(false);
    expect(viewport().contains(compose())).toBe(false);
    expect(composeBox().parentElement).toBe(document.body);
    expect(composeBox().style.position).toBe('fixed');
    for (let el: HTMLElement | null = compose(); el; el = el.parentElement) {
      expect(el.style.transform ?? '').not.toMatch(/scale\(/);
    }
    // 핀 자체는 변환 층 안에서 캔버스를 따라간다(붙는 기준).
    expect(content().querySelector('.border-dashed')).not.toBeNull();
  });

  it('핀 사각형 아래에 붙는다(핀을 덮지 않음) — 1440 넓은 창', async () => {
    await mountWithDraftPin();
    await nextFrames();
    expect(boxAt()).toMatchObject({ left: 600, top: 390 + 20 + 8 });
    expect(composeBox().dataset.side).toBe('bottom');
  });

  it('좁은 창(390)에서 핀이 오른쪽 끝이면 쓰기 칸을 창 안으로 민다 — 잘리는 칸 0(유나 실측: 곁 패널 무대 61px · 390 오른쪽 7px)', async () => {
    setWindow(390, 844);
    pinRect = { left: 372, top: 300, width: 20, height: 20 };
    await mountWithDraftPin();
    await nextFrames();
    const b = boxAt();
    expect(b.left).toBeGreaterThanOrEqual(8);
    expect(b.right).toBeLessThanOrEqual(390 - 8);
    expect(b.top).toBe(328);
  });

  it('핀 아래 자리가 모자라면 위로 뒤집는다', async () => {
    setWindow(390, 844);
    pinRect = { left: 40, top: 800, width: 20, height: 20 };
    await mountWithDraftPin();
    await nextFrames();
    expect(composeBox().dataset.side).toBe('top');
    expect(boxAt().bottom).toBe(800 - 8);
  });

  it('pan/zoom으로 핀이 움직이면 쓰기 칸도 따라간다(스크롤 · 창 크기 이벤트 없이 CSS 변환만 바뀌는 자리)', async () => {
    await mountWithDraftPin();
    await nextFrames();
    expect(boxAt().top).toBe(418);
    pinRect = { left: 200, top: 100, width: 20, height: 20 };
    await nextFrames();
    expect(boxAt()).toMatchObject({ left: 200, top: 128 });
  });

  it('핀은 그대로인데 쓰기 칸 자기 크기가 바뀌면(글꼴 · 내용) 다시 둔다 — 낡은 크기로 뒤집기 판정이 남지 않게(까디르 4757 리뷰 ⓑ)', async () => {
    pinRect = { left: 40, top: 560, width: 20, height: 20 };
    await mountWithDraftPin();
    await nextFrames();
    expect(composeBox().dataset.side).toBe('bottom');  // 아래 여유 800 − 8 − 588 = 204 ≥ 120
    BOX = { w: 224, h: 300 };
    Object.defineProperty(composeBox(), 'offsetHeight', { configurable: true, value: 300 });
    await nextFrames();
    expect(composeBox().dataset.side).toBe('top');  // 300은 아래에 안 들어가고 위(552)가 더 넓다
    expect(boxAt().bottom).toBe(560 - 8);
  });

  it('쓰기 칸 위에서 시작한 드래그는 캔버스를 움직이지 않는다(뷰포트 pan · 픽 처리 밖 — 단추 누름이 새던 원인)', async () => {
    await mountWithDraftPin();
    const before = content().style.transform;
    const box = composeBox();
    await act(async () => {
      box.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 2, clientX: 700, clientY: 450, button: 0 }));
      box.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 2, clientX: 780, clientY: 520 }));
      box.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 2, clientX: 780, clientY: 520 }));
    });
    expect(content().style.transform).toBe(before);
    expect(compose()).not.toBeNull();
  });
});

describe('쓰기 칸 위 휠은 캔버스로 넘긴다(story #4373 · 까디르 실측)', () => {
  it('ctrl+휠 = 캔버스 줌 · 원래 휠은 preventDefault(브라우저 페이지 줌 누출 0)', async () => {
    await mountWithDraftPin();
    const before = content().style.transform;
    const wheel = new WheelEvent('wheel', { deltaY: -100, clientX: 640, clientY: 400, ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => { compose()!.dispatchEvent(wheel); });
    expect(wheel.defaultPrevented).toBe(true);
    expect(content().style.transform).not.toBe(before);
    expect(content().style.transform).toMatch(/scale\(/);
  });

  it('그냥 휠(글 칸에 스크롤할 내용 없음) = 캔버스 pan · preventDefault', async () => {
    await mountWithDraftPin();
    const forwarded = vi.fn();
    viewport().addEventListener('wheel', forwarded);
    const wheel = new WheelEvent('wheel', { deltaY: 40, clientX: 640, clientY: 400, bubbles: true, cancelable: true });
    await act(async () => { composeBox().dispatchEvent(wheel); });
    expect(wheel.defaultPrevented).toBe(true);
    expect(forwarded).toHaveBeenCalledTimes(1);
    expect((forwarded.mock.calls[0]![0] as WheelEvent).deltaY).toBe(40);
  });

  it('글 칸이 스스로 스크롤할 내용이 있으면 그냥 휠은 글 칸 몫(캔버스로 안 넘김) — ctrl+휠은 그래도 캔버스', async () => {
    await mountWithDraftPin();
    const field = compose()!;
    Object.defineProperty(field, 'scrollHeight', { configurable: true, value: 200 });
    Object.defineProperty(field, 'clientHeight', { configurable: true, value: 40 });
    const forwarded = vi.fn();
    viewport().addEventListener('wheel', forwarded);
    const plain = new WheelEvent('wheel', { deltaY: 40, bubbles: true, cancelable: true });
    await act(async () => { field.dispatchEvent(plain); });
    expect(plain.defaultPrevented).toBe(false);
    expect(forwarded).not.toHaveBeenCalled();
    const zoom = new WheelEvent('wheel', { deltaY: -40, ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => { field.dispatchEvent(zoom); });
    expect(zoom.defaultPrevented).toBe(true);
    expect(forwarded).toHaveBeenCalledTimes(1);
  });
});

describe('쓰기 칸 바깥 누름 닫기는 isOutsidePress(story #4373 · #4349 부류 가드)', () => {
  const press = (target: Element) => act(async () => { target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });

  it('칸 안 누름은 안 닫힘 · 칸 위에 뜬 다른 포털 팝오버 안 누름도 안 닫힘 · 진짜 바깥 누름은 닫힘', async () => {
    await mountWithDraftPin();
    await nextFrames();  // 바깥 누름 리스너는 연 다음 프레임에 붙는다
    await press(compose()!);
    expect(compose()).not.toBeNull();

    const otherPortal = document.createElement('div');
    otherPortal.setAttribute('data-anchored-popover', '');
    const item = document.createElement('button');
    otherPortal.appendChild(item);
    document.body.appendChild(otherPortal);
    try {
      await press(item);
      expect(compose()).not.toBeNull();  // 예전 contains 판정이면 여기서 닫혔다
    } finally {
      otherPortal.remove();
    }

    await press(document.body);
    expect(compose()).toBeNull();
  });
});

