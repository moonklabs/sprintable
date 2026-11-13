// @vitest-environment jsdom
//
// 4910 — 그림 위 마우스 · 키보드 손길: 더블클릭 = 전체 보기 ↔ 실제 크기, 그림 칸에 초점이 있을 때 0 = 전체 보기 · 1 = 실제 크기.
// 새 동작 0 — 도구줄의 두 단추와 터치 더블탭이 이미 부르던 `fitToView` · `actualSize` · `toggleZoomAtPoint`를 부르는 길만 (AC2 §3).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { ArtifactStage } from './artifact-stage';
import koMessages from '../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const sizeGetters: PropertyDescriptor[] = [];

// jsdom은 clientWidth/Height가 0이라 fit이 서지 않는다 — 640×480 칸으로 고정한다. 기본 아트보드 1280×800 → fit 배율 0.5, 실제 크기 1.
beforeEach(() => {
  for (const prop of ['clientWidth', 'clientHeight'] as const) {
    sizeGetters.push(Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop) ?? { value: 0, configurable: true });
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get() { return prop === 'clientWidth' ? 640 : 480; } });
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  (['clientWidth', 'clientHeight'] as const).forEach((prop, i) => Object.defineProperty(HTMLElement.prototype, prop, sizeGetters[i]!));
  sizeGetters.length = 0;
});

async function mount(props: Partial<React.ComponentProps<typeof ArtifactStage>> = {}) {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <ArtifactStage format="html" content="<div>hi</div>" title="흐름판 시안" {...props} />
      </NextIntlClientProvider>,
    );
  });
}

const viewport = () => container.querySelector('[data-artifact-canvas-viewport]') as HTMLDivElement;
const scaleNow = () => {
  const m = /scale\(([-\d.]+)\)/.exec((container.querySelector('[data-artifact-canvas-content]') as HTMLElement).style.transform);
  return Number(m![1]);
};
const dblclick = (el: Element, x = 100, y = 100) => act(async () => { el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: x, clientY: y })); });
const key = (el: Element, k: string, init: KeyboardEventInit = {}) => act(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })); });
const touchDown = () => act(async () => { viewport().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 7, pointerType: 'touch', button: 0, clientX: 5, clientY: 5 })); });
const mouseDown = () => act(async () => { viewport().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 8, pointerType: 'mouse', button: 0, clientX: 5, clientY: 5 })); });

describe('ArtifactStage — 그림 더블클릭 (4910)', () => {
  it('처음은 전체 보기(0.5) → 더블클릭하면 실제 크기(1) → 다시 더블클릭하면 전체 보기', async () => {
    await mount();
    expect(scaleNow()).toBeCloseTo(0.5, 3);
    await dblclick(viewport());
    expect(scaleNow()).toBeCloseTo(1, 3);
    await dblclick(viewport());
    expect(scaleNow()).toBeCloseTo(0.5, 3);
  });

  it('핀 추가 모드(클릭 = 픽)에서는 줌을 바꾸지 않는다', async () => {
    await mount({ pinAddMode: true, onPickCoordinate: () => undefined });
    await dblclick(viewport());
    expect(scaleNow()).toBeCloseTo(0.5, 3);
  });

  it('편집 모드에서는 줌을 바꾸지 않는다(편집 캔버스의 더블클릭을 가로채지 않는다)', async () => {
    await mount({ mode: 'edit' });
    const before = scaleNow();
    await dblclick(viewport());
    expect(scaleNow()).toBeCloseTo(before, 3);
  });

  it('마지막 포인터가 터치였으면 무시한다(더블탭 경로가 이미 같은 일을 해서 둘 다 타면 한 번 더 뒤집힌다)', async () => {
    await mount();
    await touchDown();
    await dblclick(viewport());
    expect(scaleNow()).toBeCloseTo(0.5, 3);
    await mouseDown(); // 다시 마우스를 쓰면 살아난다
    await dblclick(viewport());
    expect(scaleNow()).toBeCloseTo(1, 3);
  });

  it('그림 위에 얹힌 핀(단추) 위의 더블클릭은 줌이 아니다', async () => {
    await mount({ overlay: <button type="button" data-testid="pin">1</button> });
    await dblclick(container.querySelector('[data-testid="pin"]')!);
    expect(scaleNow()).toBeCloseTo(0.5, 3);
  });
});

describe('ArtifactStage — 키 0 · 1 (4910)', () => {
  it('그림 칸에 초점이 있을 때 1 = 실제 크기, 0 = 전체 보기', async () => {
    await mount();
    await key(viewport(), '1');
    expect(scaleNow()).toBeCloseTo(1, 3);
    await key(viewport(), '0');
    expect(scaleNow()).toBeCloseTo(0.5, 3);
  });

  it('다른 키 · 조합키(⌘ ⌃ ⌥ ⇧)는 건드리지 않는다', async () => {
    await mount();
    await key(viewport(), '1', { metaKey: true });
    await key(viewport(), '1', { ctrlKey: true });
    await key(viewport(), '1', { altKey: true });
    await key(viewport(), '1', { shiftKey: true });
    await key(viewport(), '2');
    expect(scaleNow()).toBeCloseTo(0.5, 3);
  });

  it('안쪽 요소(핀 단추 등)에서 올라온 키는 무시한다 — 그림 칸 자신에 초점이 있을 때만', async () => {
    await mount({ overlay: <button type="button" data-testid="pin">1</button> });
    await key(container.querySelector('[data-testid="pin"]')!, '1');
    expect(scaleNow()).toBeCloseTo(0.5, 3);
  });

  it('초점을 받고 이름 · 단축키를 알린다(role=group · tabindex 0 · aria-label = 제목 · aria-keyshortcuts)', async () => {
    await mount();
    expect(viewport().getAttribute('role')).toBe('group');
    expect(viewport().getAttribute('tabindex')).toBe('0');
    expect(viewport().getAttribute('aria-label')).toBe('흐름판 시안');
    expect(viewport().getAttribute('aria-keyshortcuts')).toBe('0 1');
  });

  it('편집 모드의 그림 칸은 초점 · 키 손길을 받지 않는다', async () => {
    await mount({ mode: 'edit' });
    expect(viewport().hasAttribute('tabindex')).toBe(false);
    expect(viewport().hasAttribute('aria-keyshortcuts')).toBe(false);
    const before = scaleNow();
    await key(viewport(), '1');
    expect(scaleNow()).toBeCloseTo(before, 3);
  });

  it('도움말 글이 더블클릭과 키를 알려 준다(마우스 환경)', async () => {
    await mount();
    expect(container.textContent).toContain('더블클릭하면 전체 보기와 실제 크기가 바뀌고');
    expect(container.textContent).toContain('0 · 1 키');
  });
});
