// @vitest-environment jsdom
//
// story d425dccc — space+드래그 pan 실동작 회귀가드. jsdom은 CSS pointer-events를 실제로
// hit-test하지 않으므로(스타일 강제 무관하게 합성 이벤트가 그대로 전달됨), space 미보유 시
// 드래그를 막는 JS 가드(`if (!spaceHeld) return`)가 실제 방어선임을 직접 검증한다.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

async function mount() {
  await act(async () => {
    root.render(wrap(<ArtifactStage format="html" content="<div>hi</div>" title="t" />));
  });
}

function press(el: EventTarget, type: string, init: MouseEventInit | KeyboardEventInit = {}) {
  const Ctor = type.startsWith('key') ? KeyboardEvent : MouseEvent;
  el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, ...init }));
}

describe('ArtifactStage — html space+drag pan', () => {
  it('dragging the overlay without space held does not move the scroll container (JS guard, not just CSS)', async () => {
    await mount();
    const wrapperEl = container.querySelector('[data-artifact-stage-scroll]') as HTMLDivElement;
    const overlay = container.querySelector('[data-pan-overlay]') as HTMLDivElement;
    Object.defineProperty(wrapperEl, 'scrollLeft', { value: 0, writable: true });

    await act(async () => {
      press(overlay, 'mousedown', { clientX: 100, clientY: 0 });
      press(window, 'mousemove', { clientX: 40, clientY: 0 });
    });

    expect(wrapperEl.scrollLeft).toBe(0);
  });

  it('space held (while hovering) + drag scrolls the container by the drag delta', async () => {
    await mount();
    const wrapperEl = container.querySelector('[data-artifact-stage-scroll]') as HTMLDivElement;
    const overlay = container.querySelector('[data-pan-overlay]') as HTMLDivElement;
    Object.defineProperty(wrapperEl, 'scrollLeft', { value: 50, writable: true });
    Object.defineProperty(wrapperEl, 'scrollTop', { value: 0, writable: true });

    await act(async () => {
      press(wrapperEl, 'mouseenter');
      press(window, 'keydown', { code: 'Space' });
    });
    expect(overlay.getAttribute('data-pan-active')).toBe('true');

    await act(async () => {
      press(overlay, 'mousedown', { clientX: 100, clientY: 0 });
    });
    await act(async () => {
      press(window, 'mousemove', { clientX: 40, clientY: 0 }); // 60px left → scrollLeft += 60
    });

    expect(wrapperEl.scrollLeft).toBe(110);

    await act(async () => {
      press(window, 'keyup', { code: 'Space' });
    });
    expect(overlay.getAttribute('data-pan-active')).toBeNull();
  });

  it('space held while NOT hovering the stage does not arm the pan overlay (다른 페이지 요소 타이핑/스크롤 간섭 방지)', async () => {
    await mount();
    const overlay = container.querySelector('[data-pan-overlay]') as HTMLDivElement;

    await act(async () => {
      press(window, 'keydown', { code: 'Space' });
    });

    expect(overlay.getAttribute('data-pan-active')).toBeNull();
  });
});
