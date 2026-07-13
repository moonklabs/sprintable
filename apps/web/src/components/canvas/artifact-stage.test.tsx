// @vitest-environment jsdom
//
// story e4cce704(v2.1) — space 게이트 제거 후 직접-드래그 pan 회귀가드. space 관련 키보드
// 리스너/hover-gate가 완전히 제거됐음을 확인하고, mousedown+drag만으로 스크롤이 이동하는지
// 검증한다(v2에서 있던 "space 없으면 안 움직임" 가드는 이제 정반대 — space는 아예 무간섭).
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

async function mount() {
  await act(async () => {
    root.render(wrap(<ArtifactStage format="html" content="<div>hi</div>" title="t" />));
  });
}

function press(el: EventTarget, type: string, init: MouseEventInit = {}) {
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
}

describe('ArtifactStage — html 직접-드래그 pan(v2.1, space 게이트 없음)', () => {
  it('mousedown+drag alone scrolls the container by the drag delta (no space needed)', async () => {
    await mount();
    const wrapperEl = container.querySelector('[data-artifact-stage-scroll]') as HTMLDivElement;
    const overlay = container.querySelector('[data-pan-overlay]') as HTMLDivElement;
    Object.defineProperty(wrapperEl, 'scrollLeft', { value: 50, writable: true });
    Object.defineProperty(wrapperEl, 'scrollTop', { value: 0, writable: true });

    await act(async () => {
      press(overlay, 'mousedown', { clientX: 100, clientY: 0 });
    });
    await act(async () => {
      press(window, 'mousemove', { clientX: 40, clientY: 0 }); // 60px left → scrollLeft += 60
    });

    expect(wrapperEl.scrollLeft).toBe(110);

    await act(async () => {
      press(window, 'mouseup');
    });
    expect(overlay.style.cursor).toBe('grab'); // 드래그 종료 후 grab으로 복귀(항상 활성 어포던스)
  });

  it('shows the grab cursor at rest and grabbing while dragging (always-active affordance)', async () => {
    await mount();
    const overlay = container.querySelector('[data-pan-overlay]') as HTMLDivElement;
    expect(overlay.style.cursor).toBe('grab');

    await act(async () => {
      press(overlay, 'mousedown', { clientX: 0, clientY: 0 });
    });
    expect(overlay.style.cursor).toBe('grabbing');
  });

  it('never wires a keydown/keyup listener for Space (space 게이트 완전 제거 회귀가드)', async () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    await mount();
    const spaceListenerCalls = addSpy.mock.calls.filter(([type]) => type === 'keydown' || type === 'keyup');
    expect(spaceListenerCalls).toHaveLength(0);
    addSpy.mockRestore();
  });
});
