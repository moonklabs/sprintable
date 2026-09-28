// @vitest-environment jsdom
/**
 * story #4373 — 산출물 댓글 쓰기 칸이 캔버스 확대/축소 변환 **안**(overlay)에 그려져 무대 10%면 22×10px로 작아지고(글 안 보임)
 * 단추 누름이 뷰포트의 pan · 픽 처리로 새던 결함. 이제 쓰기 칸은 변환 **밖** 화면 층(`data-artifact-screen-overlay`, 뷰포트의
 * 형제)에 그려지고 자리만 핀을 따라간다 · 층 밖으로 넘치면 반대쪽 · 안쪽으로 붙는다.
 * jsdom엔 배치가 없어 px 크기를 잴 수 없다 — 대신 «어떤 조상도 scale 변환을 걸지 않는다» · «변환 층 밖» · «뷰포트 포인터 처리 밖»을 단언한다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ArtifactViewer } from './artifact-viewer';
import { placeComposeBox } from './comment-compose-popover';
import { MOCK_ARTIFACT, MOCK_VERSIONS, MOCK_MEMBERS } from '@/services/canvas';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const canvas = koMessages.canvas as unknown as Record<string, string>;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let rectSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  // artifact-viewer.test.tsx와 같은 기법 — bounds(DEFAULT_BOUNDS 1280x800) 1:1 매핑 rect(scale=1 · jsdom은 clientWidth 0이라 자동 맞춤 없음).
  rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, left: 0, top: 0, right: 1280, bottom: 800, width: 1280, height: 800, toJSON() { return {}; },
  } as DOMRect);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  rectSpy.mockRestore();
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
  const viewport = container.querySelector('[data-artifact-canvas-viewport]') as HTMLDivElement;
  await act(async () => {
    viewport.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, clientX, clientY, button: 0 }));
    viewport.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientX, clientY }));
  });
}
const compose = () => container.querySelector<HTMLTextAreaElement>(`textarea[placeholder="${canvas.newThreadComposePlaceholder}"]`);
const composeBox = () => compose()!.closest<HTMLElement>('[tabindex="-1"]')!;
const content = () => container.querySelector('[data-artifact-canvas-content]') as HTMLElement;

describe('산출물 댓글 쓰기 칸은 캔버스 변환 밖 화면 층에(story #4373)', () => {
  it('쓰기 칸 · 단추는 변환 층(data-artifact-canvas-content) 밖 · 화면 층 안 — 어떤 조상도 scale 변환을 걸지 않는다', async () => {
    await mountWithDraftPin();
    expect(compose()).not.toBeNull();
    expect(content().contains(compose())).toBe(false);
    expect(compose()!.closest('[data-artifact-screen-overlay]')).not.toBeNull();
    for (let el: HTMLElement | null = compose(); el && el !== container; el = el.parentElement) {
      expect(el.style.transform ?? '').not.toMatch(/scale\(/);
    }
    // 핀 자체는 변환 층 안에서 캔버스를 따라간다(자리 기준).
    expect(content().querySelector('[data-artifact-canvas-overlay]')).not.toBeNull();
  });

  it('쓰기 칸 자리는 핀의 화면 점을 따라간다 — pan/zoom이 바뀌면 함께 움직인다', async () => {
    await mountWithDraftPin(640, 400);  // 50% · 50% → 화면 점 (640, 400) · 층 크기 0(jsdom)이면 넘침 맞춤 없이 +8
    expect(composeBox().style.left).toBe('648px');
    expect(composeBox().style.top).toBe('408px');
    const sizeBefore = { className: composeBox().className, transform: composeBox().style.transform };
    const actual = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === canvas.viewerActualSizeAction)!;
    await act(async () => { actual.click(); });  // 뷰포트 0 → tx = -640 · ty = -400 → 핀 화면 점 (0, 0)
    expect(composeBox().style.left).toBe('8px');
    expect(composeBox().style.top).toBe('8px');
    // AC3 — 배율이 바뀌어도 쓰기 칸 크기를 정하는 것(클래스 · 자기 변환)은 그대로, 조상 어디에도 scale이 없다.
    expect({ className: composeBox().className, transform: composeBox().style.transform }).toEqual(sizeBefore);
    for (let el: HTMLElement | null = compose(); el && el !== container; el = el.parentElement) {
      expect(el.style.transform ?? '').not.toMatch(/scale\(/);
    }
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
  });
});

describe('placeComposeBox — 핀 곁 자리 · 넘치면 반대쪽 · 안쪽으로 붙임(story #4373 AC2)', () => {
  const SIZE = { w: 224, h: 120 };
  const AREA = { w: 390, h: 320 };
  it('기본은 핀 오른쪽 아래(+8)', () => {
    expect(placeComposeBox({ x: 50, y: 40 }, SIZE, AREA)).toEqual({ left: 58, top: 48 });
  });
  it('오른쪽 · 아래로 넘치면 반대쪽(왼쪽 · 위)', () => {
    expect(placeComposeBox({ x: 360, y: 300 }, SIZE, AREA)).toEqual({ left: 360 - 8 - 224, top: 300 - 8 - 120 });
  });
  it('반대쪽으로도 넘치면 층 안쪽 가장자리(8)에 붙인다', () => {
    expect(placeComposeBox({ x: 200, y: 100 }, { w: 380, h: 300 }, AREA)).toEqual({ left: 8, top: 8 });
  });
  it('핀이 층 밖(음수)이어도 쓰기 칸은 층 안', () => {
    const p = placeComposeBox({ x: -500, y: -500 }, SIZE, AREA);
    expect(p.left).toBeGreaterThanOrEqual(8);
    expect(p.top).toBeGreaterThanOrEqual(8);
  });
});
